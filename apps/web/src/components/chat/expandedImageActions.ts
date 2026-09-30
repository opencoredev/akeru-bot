/** Fetches an expanded image's bytes from its signed asset URL. */
async function fetchImageBlob(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`The image could not be loaded (${response.status}).`);
  return response.blob();
}

/** Downloads the image under its attachment name, even when the asset URL is cross-origin. */
export async function saveExpandedImage(item: { src: string; name: string }): Promise<void> {
  const url = URL.createObjectURL(await fetchImageBlob(item.src));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = item.name;
    anchor.click();
  } finally {
    // Revoke after the click has queued the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Clipboards only accept PNG images reliably, so other formats are re-encoded. */
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error("The image could not be converted."))),
      "image/png",
    ),
  );
}

export async function copyExpandedImage(item: { src: string }): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("This browser cannot copy images.");
  }
  const png = fetchImageBlob(item.src).then(toPngBlob);
  // Safari needs the clipboard write to start inside the click, so it gets the pending blob.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
