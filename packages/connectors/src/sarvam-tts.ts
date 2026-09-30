/**
 * Sarvam Bulbul text-to-speech (the outbound half of the voice channel):
 * agent replies can be delivered as WhatsApp voice notes for owners who
 * are on the shop floor and can't read a screen. Without SARVAM_API_KEY
 * callers fall back to text-only replies — the bot never pretends to have
 * sent audio.
 */

export interface TtsConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function sarvamTtsConfig(): TtsConfig | null {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.SARVAM_BASE_URL ?? 'https://api.sarvam.ai',
    model: process.env.SARVAM_TTS_MODEL ?? 'bulbul:v2',
  };
}

export interface TtsResult {
  ok: boolean;
  /** base64-encoded audio (mp3/ogg per provider response) */
  audioBase64?: string;
  mimeType?: string;
  error?: string;
}

/** Map a free-text reply to a Bulbul voice language hint. */
export function detectTtsLanguage(text: string): 'hi-IN' | 'en-IN' {
  // Devanagari blocks or common Hinglish markers → Hindi voice; else Indian English
  if (/[\u0900-\u097F]/.test(text)) return 'hi-IN';
  const hinglish = /\b(kitna|kitne|hai|hain|kya|karo|kar do|bhejo|batao|nahi|paisa|paisay|rupaye|kal|aaj)\b/i;
  return hinglish.test(text) ? 'hi-IN' : 'en-IN';
}

export async function synthesizeSpeech(text: string, opts: { languageCode?: 'hi-IN' | 'en-IN'; speaker?: string } = {}): Promise<TtsResult> {
  const cfg = sarvamTtsConfig();
  if (!cfg) return { ok: false, error: 'SARVAM_API_KEY not configured — voice replies are not enabled on this deployment' };

  const clean = text
    .replace(/\*/g, '')      // WhatsApp bold markers
    .replace(/[• 🔴🟡✅⚠️🚫🕓⏰]/gu, '')
    .slice(0, 1500);         // Bulbul per-request limit safety
  if (!clean.trim()) return { ok: false, error: 'nothing to speak' };

  try {
    const res = await fetch(`${cfg.baseUrl}/text-to-speech`, {
      method: 'POST',
      headers: { 'api-subscription-key': cfg.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        text: clean,
        target_language_code: opts.languageCode ?? detectTtsLanguage(clean),
        speaker: opts.speaker ?? 'anushka',
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { audios?: string[]; message?: string };
    if (!res.ok || !data.audios?.[0]) return { ok: false, error: data.message ?? `sarvam tts error (${res.status})` };
    return { ok: true, audioBase64: data.audios[0], mimeType: 'audio/mpeg' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
