// Movie shooting locations scraper (Cheerio + optional Playwright)
// Heuristics:
//  - Look for "Filming locations" / "Filming location(s)" sections (Wikipedia, local pages)
//  - Detect IMDb /locations pages and parse listed locations
//  - Parse lists, bullets, tables and inline coordinates when present
//  - Optionally enrich via Wikipedia API (MediaWiki) if configured
//
// Notes:
//  - Some sources (IMDb) may have Terms of Service that forbid scraping. Prefer official APIs or site agreements.
//  - This scaffold collects public, non-sensitive metadata only.

import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset, KeyValueStore } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://en.wikipedia.org/wiki/Inception', 'https://www.imdb.com/title/tt1375666/locations'],
  maxRequestsPerCrawl = 500,
  useBrowser = false,
  useWikipediaApi = true,
  followInternalOnly = true,
  concurrency = 10,
  validateCoordinates = false,
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration();
const dataset = await Dataset.open();
const kv = await KeyValueStore.open();

// Helpers
function resolveUrl(base, href) {
  try { return new URL(href, base).toString(); } catch (e) { return null; }
}

function tryParseCoordinates(text) {
  // common lat lon patterns: 37.7749° N, 122.4194° W OR 37.7749, -122.4194
  const decMatch = text.match(/(-?\d{1,3}\.\d+)\s*[,\s]\s*(-?\d{1,3}\.\d+)/);
  if (decMatch) {
    const lat = parseFloat(decMatch[1]);
    const lon = parseFloat(decMatch[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return { latitude: lat, longitude: lon };
  }
  // DMS pattern (rare): 37°46′29″N 122°25′10″W — basic extraction (not fully robust)
  const dmsMatch = text.match(/(\d{1,3})[°\s]+(\d{1,2})[′']\s*(\d{1,2}(?:\.\d+)?)?[″"]?\s*([NnSs])\s*,?\s*(\d{1,3})[°\s]+(\d{1,2})[′']\s*(\d{1,2}(?:\.\d+)?)?[″"]?\s*([EeWw])/);
  if (dmsMatch) {
    // naive conversion if present
    const latDeg = Number(dmsMatch[1]);
    const latMin = Number(dmsMatch[2] || 0);
    const latSec = Number(dmsMatch[3] || 0);
    const latHem = dmsMatch[4].toUpperCase();
    const lonDeg = Number(dmsMatch[5]);
    const lonMin = Number(dmsMatch[6] || 0);
    const lonSec = Number(dmsMatch[7] || 0);
    const lonHem = dmsMatch[8].toUpperCase();
    const lat = (latDeg + latMin / 60 + latSec / 3600) * (latHem === 'S' ? -1 : 1);
    const lon = (lonDeg + lonMin / 60 + lonSec / 3600) * (lonHem === 'W' ? -1 : 1);
    return { latitude: lat, longitude: lon };
  }
  return null;
}

function extractPossibleLocationsFromText(text) {
  // Split by semicolon / line break / "—" and return candidates
  const parts = text.split(/[\n;—–-]+/).map(s => s.trim()).filter(Boolean);
  return parts;
}

// Wikipedia API fetch (MediaWiki) to get wikitext sections
async function fetchWikipediaWikitext(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('wikipedia.org')) return null;
    const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, ''));
    const apiUrl = `https://${u.hostname}/w/index.php?title=${encodeURIComponent(title)}&action=raw`;
    const res = await fetch(apiUrl);
    if (!res.ok) return null;
    const text = await res.text();
    return text;
  } catch (e) {
    return null;
  }
}

function findFilmingLocationsFromWikiWikitext(wikitext) {
  if (!wikitext) return [];
  // simple heuristic: find "Filming locations" section header and capture following lines until next section
  const regex = /(?:(==+\s*Filming locations\s*==+)[\s\S]*?)(?==+)/i;
  const m = wikitext.match(regex);
  if (!m) return [];
  const section = m[0];
  // remove markup, capture lines
  const cleaned = section.replace(/'''/g, '').replace(/\{\{.*?\}\}/g, '').replace(/\[http[^\]]+\]/g, '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2$1');
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  // attempt to collect lines that look like locations
  const hits = lines.filter(l => l.length > 5 && l.length < 400).slice(0, 200);
  return hits;
}

// Common extractor for Cheerio pages
async function extractFromCheerio({ request, $, log }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Processing (cheerio)', { url });

  // Movie title heuristics
  const title = $('h1, #firstHeading').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';

  // Year heuristic from title or page
  const yearMatch = title.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : '';

  const bodyText = $('body').text();

  // 1) Wikipedia pages: find "Filming locations" section using DOM (strong first preference)
  let locations = [];
  // search heading nodes with "Filming location(s)"
  const headings = $('h2, h3, h4').filter((i, el) => $(el).text().toLowerCase().includes('filming location'));
  if (headings.length) {
    headings.each((i, h) => {
      // gather sibling nodes until next heading of same level
      let node = $(h).next();
      let gathered = '';
      let steps = 0;
      while (node && node.length && steps < 200) {
        if (/^h[1-6]$/i.test(node[0].name)) break;
        gathered += '\n' + node.text();
        node = node.next();
        steps++;
      }
      if (gathered.trim()) {
        locations.push(...extractPossibleLocationsFromText(gathered));
      }
    });
  }

  // 2) IMDb locations pages: specific layout with lists under .soda or .ipl-list or list items
  if (/imdb\.com\/title\/.+\/locations/i.test(url) || ($('#filmingLocations').length && locations.length === 0)) {
    // IMDb known patterns: .soda, .list, .ipl-zebra-list__item, li
    const candidates = $('li, .ipl-zebra-list__item, .soda, .filming-location').map((i, el) => $(el).text().trim()).get();
    locations.push(...candidates.filter(Boolean));
  }

  // 3) Generic fallback: look for lines containing "filming location" or "location:" or place names
  if (locations.length === 0) {
    const fallbackMatches = [];
    const paragraphs = $('p, li, td').map((i, el) => $(el).text().trim()).get();
    for (const p of paragraphs) {
      if (/filming location|filming locations|locations used|location(s)?/i.test(p)) {
        fallbackMatches.push(p);
      }
    }
    locations.push(...fallbackMatches);
  }

  // 4) Special: if this is a Wikipedia page and user opted for API, try raw wikitext parsing for cleaner results
  if (useWikipediaApi && url.includes('wikipedia.org')) {
    const wikitext = await fetchWikipediaWikitext(url);
    if (wikitext) {
      const wikiLocations = findFilmingLocationsFromWikiWikitext(wikitext);
      if (wikiLocations.length) {
        locations = wikiLocations.concat(locations);
      }
    }
  }

  // Normalize and deduplicate location candidates
  const seen = new Set();
  const normalized = [];
  for (const loc of locations) {
    const text = loc.replace(/\s+/g, ' ').trim();
    if (!text || text.length < 3) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }

  // For each normalized location text, attempt basic coordinate extraction and quick city/country heuristics
  for (const locText of normalized.slice(0, 200)) {
    const coords = tryParseCoordinates(locText) || {};
    // Attempt to pick city/country by splitting on commas and heuristics
    const parts = locText.split(',').map(s => s.trim()).filter(Boolean);
    let city = '';
    let region = '';
    let country = '';
    if (parts.length >= 1) city = parts[0];
    if (parts.length === 2) country = parts[1];
    if (parts.length >= 3) {
      region = parts[1];
      country = parts.slice(2).join(', ');
    }

    const record = {
      movie_title: title || '',
      year: year || '',
      location_text: locText,
      city: city || '',
      region: region || '',
      country: country || '',
      latitude: coords.latitude || null,
      longitude: coords.longitude || null,
      source_url: url,
      extracted_at: new Date().toISOString()
    };

    await dataset.pushData(record);
  }

  // Save full page extraction to KV for audit/analysis
  try {
    await kv.setValue(`pages/${encodeURIComponent(url)}`, {
      url,
      title,
      extracted_locations: normalized.slice(0, 500),
      timestamp: new Date().toISOString()
    }, { contentType: 'application/json' });
  } catch (e) {
    log.warning('Failed to save page extraction to KV', { url, error: e.message });
  }
}

// Playwright handler: render then reuse Cheerio-like logic via page.content()
async function extractFromPlaywright({ page, request, log }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Processing (playwright)', { url });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const html = await page.content();
  // Use Cheerio over the rendered HTML
  const cheerio = (await import('cheerio'));
  const $ = cheerio.load(html);
  await extractFromCheerio({ request, $, log });
}

// Entry point: choose crawler
if (!useBrowser) {
  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    maxConcurrency: concurrency,
    requestHandlerTimeoutSecs: 60,
    async requestHandler(ctx) {
      await extractFromCheerio(ctx);
    },
  });

  const startRequests = (startUrls || []).map((u) => {
    try {
      const p = new URL(u);
      return { url: u, userData: { startHost: p.host } };
    } catch (e) {
      return { url: u, userData: {} };
    }
  });

  await crawler.run(startRequests);
} else {
  const crawler = new PlaywrightCrawler({
    launchContext: {},
    maxRequestsPerCrawl,
    requestHandlerTimeoutSecs: 120,
    async requestHandler(ctx) {
      await extractFromPlaywright(ctx);
    },
  });

  const startRequests = (startUrls || []).map((u) => ({ url: u }));
  await crawler.run(startRequests);
}

await Actor.exit();
