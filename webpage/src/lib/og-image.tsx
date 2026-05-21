import { ImageResponse } from "@takumi-rs/image-response"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import sharp from "sharp"

type FontEntry = {
  name: string
  data: ArrayBuffer
  weight: number
  style: string
}

let cachedFonts: FontEntry[] | null = null
let cachedSvg: Buffer | null = null
const logoRasterCache = new Map<string, ArrayBuffer>()

async function loadFonts(): Promise<FontEntry[]> {
  if (cachedFonts) return cachedFonts
  const cwd = process.cwd()
  const sans400 = await readFile(
    resolve(
      cwd,
      "node_modules/@fontsource/albert-sans/files/albert-sans-latin-400-normal.woff2",
    ),
  )
  const sans800 = await readFile(
    resolve(
      cwd,
      "node_modules/@fontsource/albert-sans/files/albert-sans-latin-800-normal.woff2",
    ),
  )
  const sans900 = await readFile(
    resolve(
      cwd,
      "node_modules/@fontsource/albert-sans/files/albert-sans-latin-900-normal.woff2",
    ),
  )
  const mono400 = await readFile(
    resolve(
      cwd,
      "node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
    ),
  )
  cachedFonts = [
    {
      name: "Albert Sans",
      data: sans400.buffer as ArrayBuffer,
      weight: 400,
      style: "normal",
    },
    {
      name: "Albert Sans",
      data: sans800.buffer as ArrayBuffer,
      weight: 800,
      style: "normal",
    },
    {
      name: "Albert Sans",
      data: sans900.buffer as ArrayBuffer,
      weight: 900,
      style: "normal",
    },
    {
      name: "IBM Plex Mono",
      data: mono400.buffer as ArrayBuffer,
      weight: 400,
      style: "normal",
    },
  ]
  return cachedFonts
}

async function loadLogoSvg(): Promise<Buffer> {
  if (cachedSvg) return cachedSvg
  cachedSvg = await readFile(
    resolve(process.cwd(), "src/assets/effect-uai-logo.svg"),
  )
  return cachedSvg
}

// Rasterize the SVG logo to a PNG at the exact pixel size we plan to embed
// it at. Cached per-size so each unique dimension is rendered once. Avoids
// the blur that comes from scaling a fixed-resolution PNG up or down.
async function rasterizeLogo(
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  const key = `${width}x${height}`
  const cached = logoRasterCache.get(key)
  if (cached) return cached
  const svg = await loadLogoSvg()
  // Supersample 3× so Takumi's downscale to the display size still has
  // plenty of source pixels per output pixel.
  const png = await sharp(svg)
    .resize(Math.round(width * 3), Math.round(height * 3), {
      fit: "fill",
      kernel: "lanczos3",
    })
    .png({ compressionLevel: 9 })
    .toBuffer()
  const ab = png.buffer.slice(
    png.byteOffset,
    png.byteOffset + png.byteLength,
  ) as ArrayBuffer
  logoRasterCache.set(key, ab)
  return ab
}

export interface OgImageInput {
  title: string
  subtitle?: string
  eyebrow?: string
}

const URL_FULL = "https://effect-uai.betalyra.com"

// Logo native aspect ratio (1000 × 320 source).
const LOGO_ASPECT = 1000 / 320

export async function createOgImage({
  title,
  subtitle,
  eyebrow,
}: OgImageInput): Promise<Response> {
  const fonts = await loadFonts()

  const isHomepage = title === "effect-uai"

  const titleSize =
    title.length > 80
      ? 80
      : title.length > 50
        ? 104
        : title.length > 30
          ? 128
          : 160

  const cornerLogoH = 64
  const cornerLogoW = cornerLogoH * LOGO_ASPECT
  const heroLogoH = 300
  const heroLogoW = heroLogoH * LOGO_ASPECT

  const logoW = isHomepage ? heroLogoW : cornerLogoW
  const logoH = isHomepage ? heroLogoH : cornerLogoH
  const logoData = await rasterizeLogo(logoW, logoH)

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#fafafa",
          fontFamily: "Albert Sans",
          color: "#0a0a0a",
          padding: "64px 80px",
        }}
      >
        {/* Top: logo (large for homepage, small corner mark for doc pages) */}
        <div style={{ display: "flex" }}>
          <img
            src="logo"
            width={isHomepage ? heroLogoW : cornerLogoW}
            height={isHomepage ? heroLogoH : cornerLogoH}
          />
        </div>

        {/* Middle: eyebrow + big title + subtitle (doc pages only) */}
        {!isHomepage && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              justifyContent: "center",
            }}
          >
            {eyebrow && (
              <div
                style={{
                  fontFamily: "IBM Plex Mono",
                  fontSize: "22px",
                  color: "#6b6b6b",
                  marginBottom: "16px",
                  display: "flex",
                }}
              >
                {eyebrow}
              </div>
            )}
            <div
              style={{
                fontFamily: "Albert Sans",
                fontWeight: 900,
                fontSize: `${titleSize}px`,
                color: "#0a0a0a",
                lineHeight: 1.0,
                letterSpacing: "-0.04em",
                maxWidth: "1040px",
                display: "flex",
              }}
            >
              {title}
            </div>
            {subtitle && (
              <div
                style={{
                  fontFamily: "Albert Sans",
                  fontWeight: 400,
                  fontSize: "30px",
                  color: "#4a4a4a",
                  marginTop: "24px",
                  lineHeight: 1.35,
                  maxWidth: "1040px",
                  display: "flex",
                }}
              >
                {subtitle}
              </div>
            )}
          </div>
        )}

        {/* Homepage: tagline below the big logo */}
        {isHomepage && subtitle && (
          <div
            style={{
              fontFamily: "Albert Sans",
              fontWeight: 400,
              fontSize: "40px",
              color: "#4a4a4a",
              lineHeight: 1.35,
              maxWidth: "1040px",
              display: "flex",
            }}
          >
            {subtitle}
          </div>
        )}

        {/* Footer: hairline + url */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "24px",
          }}
        >
          <div
            style={{
              height: "1px",
              background: "#dcdcdc",
              flex: 1,
            }}
          />
          <div
            style={{
              fontFamily: "IBM Plex Mono",
              fontSize: "20px",
              color: "#6b6b6b",
              letterSpacing: "0.04em",
              display: "flex",
            }}
          >
            {URL_FULL}
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      format: "png",
      fonts: fonts as any,
      persistentImages: [{ src: "logo", data: logoData }],
    },
  )
}
