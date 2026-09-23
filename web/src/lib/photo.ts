// Every photo that reaches the terminal is shaped here first. The terminal
// makes its own enrollment photos as ~45-60 KB portraits; a raw webcam frame
// or phone JPEG is a 200 KB - 5 MB landscape with a small face, and the
// firmware answers `DATA UPDATE BIOPHOTO` with `Return=-1001` instead of
// building a template from it. Centre-crop to 3:4 and scale to the size the
// device itself produces.
// ponytail: fixed target size, tune here if a firmware wants something else.
export const DEVICE_PHOTO_WIDTH = 480;
export const DEVICE_PHOTO_HEIGHT = 640;
const JPEG_QUALITY = 0.85;

export function renderDevicePhoto(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<File> {
  const targetRatio = DEVICE_PHOTO_WIDTH / DEVICE_PHOTO_HEIGHT;
  let cropW = sourceWidth;
  let cropH = sourceHeight;
  if (cropW / cropH > targetRatio) cropW = Math.round(cropH * targetRatio);
  else cropH = Math.round(cropW / targetRatio);
  const sx = Math.round((sourceWidth - cropW) / 2);
  const sy = Math.round((sourceHeight - cropH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = DEVICE_PHOTO_WIDTH;
  canvas.height = DEVICE_PHOTO_HEIGHT;
  canvas
    .getContext("2d")
    ?.drawImage(source, sx, sy, cropW, cropH, 0, 0, DEVICE_PHOTO_WIDTH, DEVICE_PHOTO_HEIGHT);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }))
          : reject(new Error("The browser could not encode the photo.")),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

/** Re-encode a chosen JPEG file to the device shape. */
export async function normalizePhotoFile(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    return await renderDevicePhoto(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
