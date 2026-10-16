import { TOKEN_REFRESH_BEFORE_EXPIRY, DEFAULT_OUTPUT_FORMAT, BATCH_SIZE, BATCH_DELAY_MS, RETRY_DELAY_MS, MAX_RETRIES, MAX_CHUNKS } from '../config/constants.js';
import { getSsml } from '../utils/xml.js';
import { sign } from '../utils/crypto.js';
import { delay, optimizedTextSplit } from '../utils/text.js';
import { makeCORSHeaders } from '../utils/cors.js';

// Token 信息缓存
let tokenInfo = {
    endpoint: null,
    token: null,
    expiredAt: null
};

// 获取 Microsoft TTS Endpoint
export async function getEndpoint() {
    const now = Date.now() / 1000;

    if (tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
        return tokenInfo.endpoint;
    }

    // 获取新token
    const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
    const clientId = crypto.randomUUID().replace(/-/g, "");

    try {
        const response = await fetch(endpointUrl, {
            method: "POST",
            headers: {
                "Accept-Language": "zh-Hans",
                "X-ClientVersion": "4.0.530a 5fe1dc6c",
                "X-UserId": "0f04d16a175c411e",
                "X-HomeGeographicRegion": "zh-Hans-CN",
                "X-ClientTraceId": clientId,
                "X-MT-Signature": await sign(endpointUrl),
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": "0",
                "Accept-Encoding": "gzip"
            }
        });

        if (!response.ok) {
            throw new Error(`获取endpoint失败: ${response.status}`);
        }

        const data = await response.json();
        const jwt = data.t.split(".")[1];
        const decodedJwt = JSON.parse(atob(jwt));

        tokenInfo = {
            endpoint: data,
            token: data.t,
            expiredAt: decodedJwt.exp
        };

        return data;

    } catch (error) {
        console.error("获取endpoint失败:", error);
        if (tokenInfo.token) {
            console.log("使用过期的缓存token");
            return tokenInfo.endpoint;
        }
        throw error;
    }
}

// 获取单个音频数据 (MODIFICADO: nuevo host y autenticación)
export async function getAudioChunk(text, voiceName, rate, pitch, volume, style, outputFormat = DEFAULT_OUTPUT_FORMAT, maxRetries = MAX_RETRIES) {
    const retryDelay = RETRY_DELAY_MS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const endpoint = await getEndpoint();
            
            // ⚠️ CAMBIO 1: Nuevo host de Microsoft
            const url = `https://api.msedgeservices.com/tts/cognitiveservices/v1?Ocp-Apim-Subscription-Key=${endpoint.t}`;

            let m = text.match(/\[(\d+)\]\s*?$/);
            let slien = 0;
            if (m && m.length == 2) {
                slien = parseInt(m[1]);
                text = text.replace(m[0], '');
            }

            if (!text.trim()) {
                throw new Error("文本块为空");
            }

            if (text.length > 2000) {
                throw new Error(`文本块过长: ${text.length} 字符，最大支持2000字符`);
            }

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    // ⚠️ CAMBIO 2: Ya no se usa "Authorization", ahora va en la URL
                    "Content-Type": "application/ssml+xml",
                    // ⚠️ CAMBIO 3: User-Agent de Edge (esencial para el nuevo host)
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
                    "X-Microsoft-OutputFormat": outputFormat
                },
                body: getSsml(text, voiceName, rate, pitch, volume, style, slien)
            });

            if (!response.ok) {
                const errorText = await response.text();

                if (response.status === 429) {
                    if (attempt < maxRetries) {
                        console.log(`频率限制，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`请求频率过高，已重试${maxRetries}次仍失败`);
                } else if (response.status >= 500) {
                    if (attempt < maxRetries) {
                        console.log(`服务器错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`Edge TTS服务器错误: ${response.status} ${errorText}`);
                } else {
                    throw new Error(`Edge TTS API错误: ${response.status} ${errorText}`);
                }
            }

            return await response.blob();

        } catch (error) {
            if (attempt === maxRetries) {
                throw new Error(`音频生成失败（已重试${maxRetries}次）: ${error.message}`);
            }

            if (error.message.includes('fetch') || error.message.includes('network')) {
                console.log(`网络错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                await delay(retryDelay * (attempt + 1));
                continue;
            }

            throw error;
        }
    }
}

// 批量处理音频块
export async function processBatchedAudioChunks(chunks, voiceName, rate, pitch, volume, style, outputFormat, batchSize = BATCH_SIZE, delayMs = BATCH_DELAY_MS) {
    const audioChunks = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const batchPromises = batch.map(async (chunk, index) => {
            try {
                if (index > 0) {
                    await delay(index * 200);
                }
                return await getAudioChunk(chunk, voiceName, rate, pitch, volume, style, outputFormat);
            } catch (error) {
                console.error(`处理音频块失败 (批次 ${Math.floor(i/batchSize) + 1}, 块 ${index + 1}):`, error);
                throw error;
            }
        });

        try {
            const batchResults = await Promise.all(batchPromises);
            audioChunks.push(...batchResults);

            if (i + batchSize < chunks.length) {
                await delay(delayMs);
            }
        } catch (error) {
            console.error(`批次处理失败:`, error);
            throw error;
        }
    }

    return audioChunks;
}

// 主要的 TTS 函数
export async function getVoice(text, voiceName, rate, pitch, volume, style, outputFormat = DEFAULT_OUTPUT_FORMAT) {
    try {
        const cleanText = text.trim();
        if (!cleanText) {
            throw new Error("文本内容为空");
        }

        if (cleanText.length <= 1500) {
            const audioBlob = await getAudioChunk(cleanText, voiceName, rate, pitch, volume, style, outputFormat);
            return new Response(audioBlob, {
                headers: {
                    "Content-Type": "audio/mpeg",
                    ...makeCORSHeaders()
                }
            });
        }

        const chunks = optimizedTextSplit(cleanText, 1500);

        if (chunks.length > MAX_CHUNKS) {
            throw new Error(`文本过长，分块数量(${chunks.length})超过限制。请缩短文本或分批处理。`);
        }

        console.log(`文本已分为 ${chunks.length} 个块进行处理`);

        const audioChunks = await processBatchedAudioChunks(
            chunks,
            voiceName,
            rate,
            pitch,
            volume,
            style,
            outputFormat,
            BATCH_SIZE,
            BATCH_DELAY_MS
        );

        const concatenatedAudio = new Blob(audioChunks, { type: 'audio/mpeg' });
        return new Response(concatenatedAudio, {
            headers: {
                "Content-Type": "audio/mpeg",
                ...makeCORSHeaders()
            }
        });

    } catch (error) {
        console.error("语音合成失败:", error);
        return new Response(JSON.stringify({
            error: {
                message: error.message || String(error),
                type: "api_error",
                param: `${voiceName}, ${rate}, ${pitch}, ${volume}, ${style}, ${outputFormat}`,
                code: "edge_tts_error"
            }
        }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });
    }
}
