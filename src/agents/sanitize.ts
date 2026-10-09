/** Strip model control-token leakage (e.g. DeepSeek <ds_s>) from model text. */
export function sanitize(text: string): string {
  return text.replace(/<[a-zA-Z_|][a-zA-Z0-9_|]*>/g, "");
}
