// ---------------------------------------------------------------------------
// Telegram Bot API client — pure API layer
// ---------------------------------------------------------------------------

const TG_API = "https://api.telegram.org/bot";

export async function tgApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<any> {
  try {
    const resp = await fetch(`${TG_API}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await resp.json();
    if (!json.ok) {
      console.error(`[telegram] tgApi(${method}) error: ${json.description || JSON.stringify(json)}`);
    }
    return json;
  } catch (err) {
    console.error(`[telegram] tgApi(${method}) fetch error: ${String(err)}`);
    return null;
  }
}
