/**
 * Sarvam AI speech-to-text (PRD F9 voice path): WhatsApp voice notes become
 * text the operations agent can act on. The owner speaks Hinglish on the
 * shop floor — Sarvam's saarika model handles Indian languages natively.
 * Without SARVAM_API_KEY the caller gets a clear, non-throwing error so the
 * webhook can tell the owner transcription is not enabled on this deploy.
 */

export interface SarvamConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function sarvamEnvConfig(): SarvamConfig | null {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.SARVAM_BASE_URL ?? 'https://api.sarvam.ai',
    model: process.env.SARVAM_STT_MODEL ?? 'saarika:v2.5',
  };
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  /** language code detected by Sarvam (e.g. 'en-IN', 'hi-IN', 'ta-IN') */
  languageCode?: string;
  error?: string;
}

/**
 * Transcribe an audio file. Media is downloaded from Meta's CDN with the
 * bearer token and POSTed to Sarvam as multipart form-data.
 */
export async function transcribeVoiceNote(
  mediaUrl: string,
  mediaAuth: string,
  opts: { mimeType?: string } = {}
): Promise<TranscribeResult> {
  const cfg = sarvamEnvConfig();
  if (!cfg) return { ok: false, error: 'SARVAM_API_KEY not configured — voice notes are not enabled on this deployment' };

  let audio: ArrayBuffer;
  try {
    const res = await fetch(mediaUrl, {
      headers: { authorization: `Bearer ${mediaAuth}` },
    });
    if (!res.ok) return { ok: false, error: `media download failed (${res.status})` };
    audio = await res.arrayBuffer();
  } catch (e) {
    return { ok: false, error: `media download failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (audio.byteLength > 25 * 1024 * 1024) {
    return { ok: false, error: 'voice note too large (25MB max)' };
  }

  const form = new FormData();
  const mime = opts.mimeType ?? 'audio/ogg';
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : mime.includes('amr') ? 'amr' : 'ogg';
  form.append('file', new Blob([audio], { type: mime }), `voice.${ext}`);
  form.append('model', cfg.model);

  try {
    const res = await fetch(`${cfg.baseUrl}/speech-to-text/translate`, {
      method: 'POST',
      headers: { 'api-subscription-key': cfg.apiKey },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as { transcript?: string; text?: string; language_code?: string; message?: string };
    if (!res.ok) {
      return { ok: false, error: data.message ?? `sarvam error (${res.status})` };
    }
    const text = (data.transcript ?? data.text ?? '').trim();
    if (!text) return { ok: false, error: 'empty transcript' };
    return { ok: true, text, languageCode: data.language_code };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
