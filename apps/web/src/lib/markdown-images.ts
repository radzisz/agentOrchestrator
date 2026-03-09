/** Extract image URLs from markdown text */
export function extractImages(text: string | null): string[] {
  if (!text) return [];
  const urls: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) urls.push(m[1]);
  return urls;
}

/** Strip markdown image syntax from text for plain description display */
export function stripImages(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]+\)/g, "").trim();
}
