import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../types";
import { DriveError } from "./store";

// HTML -> PDF with Cloudflare Browser Rendering. The page size is the
// reMarkable 2 screen (1404x1872 px at 226 dpi = 157.8 x 210.4 mm), so the
// tablet shows each page full-screen with no zoom.

const NAV_TIMEOUT_MS = 30_000;

export async function renderPdf(env: Env, src: { url: string } | { html: string }): Promise<{ pdf: Uint8Array; title: string }> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1200 });
    try {
      if ("url" in src) await page.goto(src.url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      else await page.setContent(src.html, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      // Pages that never go quiet (ads, long polling) still have their content: print what loaded.
      if (!(err instanceof Error && err.name === "TimeoutError")) throw new DriveError(502, `page load failed: ${err}`);
    }
    const title = (await page.title()).trim();
    const pdf = await page.pdf({
      width: "158mm",
      height: "210mm",
      margin: { top: "8mm", bottom: "8mm", left: "7mm", right: "7mm" },
      printBackground: false,
    });
    return { pdf: new Uint8Array(pdf), title };
  } finally {
    await browser.close();
  }
}
