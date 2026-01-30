# Movie shooting locations scraper — AGENTS

This Actor crawls public pages (Wikipedia, IMDb "locations" pages, film commission directories, local news) to extract filming/shooting locations for movies.

Do:
- Use the default CheerioCrawler for static pages; set `useBrowser=true` for JS-heavy sites.
- Use `useWikipediaApi=true` to attempt to parse raw wiki markup (MediaWiki) for cleaner "Filming locations" sections.
- Save raw page outputs to Key-Value store for auditing and manual review.
- Respect robots.txt and site Terms of Service; do not use this to attempt to access private or restricted content.

Important legal & ethical notes:
- IMDb and some directories explicitly disallow scraping in their Terms of Service. Before scraping IMDb or other commercial sites, verify the site's ToS and prefer official APIs or license agreements.
- Wikipedia is permissively licensed but still requires attribution and compliance with license when republishing content.
- Avoid collecting personal or sensitive data. This Actor is intended to collect public non-personal metadata about filming locations.

Suggested next steps / improvements:
- Integrate a geocoding provider (Nominatim, Google Geocoding, Mapbox) to normalize location text into precise coordinates and structured city/country. (Requires API key and respecting provider TOS.)
- Add site-specific parsers for IMDb, TMDb, Letterboxd, and popular film commission sites to improve accuracy.
- Add deduplication across sources and create a canonical location entity per movie.
- Add incremental mode / scheduling to build time-series or to periodically re-validate invite/coordinates.
- Export aggregated CSVs, GeoJSON outputs, or map tiles for visualization.

Quick commands:
- Install dependencies: npm install
- Run locally: apify run
- Deploy to Apify Console: apify login && apify push

If you want, I can implement one of the suggested improvements now (pick one): geocoding integration, site-specific IMDb parser, deduplication/normalization, CSV/GeoJSON export, or incremental snapshot mode.