const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Small standalone result page for browser redirects that land on the Worker. */
export function resultPage(status: number, title: string, message: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Akeru Cloud</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fafaf9; color: #1c1917; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; padding: 2rem; }
  h1 { font-size: 1.125rem; margin: 0 0 0.5rem; }
  p { margin: 0; color: #57534e; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #fafaf9; } p { color: #a8a29e; } }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;

  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
