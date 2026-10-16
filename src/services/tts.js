import { UniversalEdgeTTS } from 'edge-tts-universal';
import { makeCORSHeaders } from '../utils/cors.js';
import { DEFAULT_OUTPUT_FORMAT } from '../config/constants.js';

// Función principal de TTS
export async function getVoice(text, voiceName, rate, pitch, volume, style, outputFormat = DEFAULT_OUTPUT_FORMAT) {
    try {
        const cleanText = text.trim();
        if (!cleanText) {
            throw new Error("文本内容为空");
        }

        // Formatear pitch para la librería (espera formato "+0Hz" o "-5Hz")
        const pitchFormatted = pitch.startsWith('+') || pitch.startsWith('-') ? pitch : `+${pitch}Hz`;
        
        // Formatear rate para la librería (espera formato "+0%" o "-10%")
        // Si rate viene como "+5%" ya está bien, si viene como "5%" lo formateamos
        const rateFormatted = rate.startsWith('+') || rate.startsWith('-') ? rate : `+${rate}`;

        const tts = new UniversalEdgeTTS(cleanText, voiceName, {
            rate: rateFormatted,
            pitch: pitchFormatted,
            volume: volume || '+0%'
        });

        const result = await tts.synthesize();

        // La librería devuelve un Blob en el objeto result
        const audioBlob = result.audio;

        return new Response(audioBlob, {
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

// Exportamos funciones dummy para mantener compatibilidad con imports existentes
// (no se usan más, pero evitan errores de import)
export async function getAudioChunk() { throw new Error("No implementado"); }
export async function processBatchedAudioChunks() { throw new Error("No implementado"); }
export async function getEndpoint() { throw new Error("No implementado"); }
