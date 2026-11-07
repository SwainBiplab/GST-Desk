/** Pixels in, words with positions out. Engines: the OCR sidecar, Tesseract in the browser, or a fixture. */

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, row-major, `width * height * 4` bytes. */
  data: Uint8ClampedArray;
}

export interface OcrBox {
  text: string;
  /** Pixel box in the image the engine was given. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1 */
  confidence: number;
}

export interface OcrResult {
  width: number;
  height: number;
  boxes: OcrBox[];
  /** Which engine and model produced it. */
  engine: string;
}

export interface OcrEngine {
  readonly id: string;
  recognise(
    image: RasterImage,
    opts?: { languages?: string[]; signal?: AbortSignal },
  ): Promise<OcrResult>;
}

/** An image as 8-bit grey, one byte per pixel. */
export interface GreyImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
