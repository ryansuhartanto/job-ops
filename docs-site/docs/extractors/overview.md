---
id: overview
title: Extractors Overview
description: Technical index of supported extractors and how they work.
sidebar_position: 1
---

This page helps you choose the right extractor for your run, understand key constraints, and navigate to detailed technical guides.

Extractor integrations are now registered through manifests and loaded automatically at orchestrator startup. Runtime discovery only scans `extractors/*/(manifest.ts|src/manifest.ts)` and does not read manifests from `orchestrator/**`. Extractor-specific run logic should also remain in `extractors/<name>/` so orchestrator stays source-agnostic. To add a new source, follow [Add an Extractor](/docs/next/workflows/add-an-extractor).

## Extractor chooser

| Extractor | Best use case | Core constraints/dependencies | Notable controls | Output/behavior notes |
| --- | --- | --- | --- | --- |
| [Gradcracker](/docs/next/extractors/gradcracker) | UK graduate roles from Gradcracker | Crawling stability depends on page structure and anti-bot behavior; tuned for low concurrency | `GRADCRACKER_SEARCH_TERMS`, `GRADCRACKER_MAX_JOBS_PER_TERM`, `JOBOPS_SKIP_APPLY_FOR_EXISTING` | Scrapes listing metadata, then detail pages and apply URL resolution |
| [JobSpy](/docs/next/extractors/jobspy) | Multi-source discovery (Indeed, LinkedIn, Glassdoor) | Requires Python wrapper execution per term; source availability and quality vary by site/location | `JOBSPY_SITES`, `JOBSPY_SEARCH_TERMS`, `JOBSPY_RESULTS_WANTED`, `JOBSPY_HOURS_OLD`, `JOBSPY_LINKEDIN_FETCH_DESCRIPTION` | Produces JSON per term, emits structured location evidence, then orchestrator normalizes and de-duplicates by `jobUrl` |
| [Adzuna](/docs/next/extractors/adzuna) | API-based multi-country discovery with low scraping overhead | Requires valid App ID/App Key; country must be in Adzuna-supported list | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `ADZUNA_MAX_JOBS_PER_TERM` | API pagination to dataset output, emits structured location evidence, and orchestrator maps progress and de-duplicates by `sourceJobId`/`jobUrl` |
| [Hiring Cafe](/docs/next/extractors/hiring-cafe) | Browser-backed discovery using Hiring Cafe search APIs | Subject to upstream anti-bot checks; uses browser context and encoded search-state payloads | `HIRING_CAFE_SEARCH_TERMS`, `HIRING_CAFE_COUNTRY`, `HIRING_CAFE_MAX_JOBS_PER_TERM`, `HIRING_CAFE_DATE_FETCHED_PAST_N_DAYS` | Uses existing pipeline term/country/budget knobs, emits structured location evidence, and maps directly to normalized jobs |
| [startup.jobs](/docs/next/extractors/startup-jobs) | Startup-focused discovery through the published `startup-jobs-scraper` package | No credentials required; detail enrichment depends on Playwright browser binaries being installed | existing pipeline `searchTerms`, selected country/cities, `jobspyResultsWanted`; `bunx --bun playwright install` for fresh environments | Algolia-backed search plus detail-page enrichment via package import; orchestrator maps normalized records and de-duplicates by `jobUrl` |
| [Working Nomads](/docs/next/extractors/working-nomads) | Remote-only discovery through the public Working Nomads jobs API | Public API is curated and remote-only; available fields are limited to API payload shape | existing pipeline `searchTerms`, selected country/cities, `jobspyResultsWanted`, workplace type | Fetches a single public JSON feed, filters locally by terms/location, emits structured location evidence, infers job type when possible, and de-duplicates by source id / URL |
| [Golang Jobs](/docs/next/extractors/golang-jobs) | Go-specific discovery through the public Golang Jobs feed | Depends on the site's public Supabase-backed schema staying stable; no credentials required | existing pipeline `searchTerms`, selected country/cities, `jobspyResultsWanted`, workplace type | Paginates the public jobs feed, maps location through the linked city record, then filters locally and de-duplicates by source id / URL |
| [Jobindex](/docs/next/extractors/jobindex) | Denmark job search through Jobindex result pages | Denmark-only; city filtering depends on resolving selected cities to Jobindex `geoareaid` values | existing pipeline `searchTerms`, selected country/cities, `JOBINDEX_MAX_JOBS_PER_TERM` / automatic run budget | Parses the embedded Stash payload, applies resolved `geoareaid` filters when available, paginates result pages, maps card metadata and direct apply links, and de-duplicates by source id / URL |
| [Seek](/docs/next/extractors/seek) | Australia/NZ job search via Apify | Requires Apify API token; actor runs incur cost ($1.50/1,000 results; free tier ~3,000/month) | `APIFY_TOKEN`, `SEEK_MAX_JOBS_PER_TERM`, `SEEK_APIFY_ACTOR_ID` | Calls the `unfenced-group/seek-com-au-scraper` Apify actor per term, maps results, and de-duplicates by source id / URL |
| [FreeHire](/docs/next/extractors/freehire) | Broad job discovery through FreeHire's public agent API | No credentials required; API availability and rate limits are controlled by FreeHire | existing pipeline `searchTerms`, selected country/cities, `jobspyResultsWanted`, workplace type | Requests full Markdown descriptions and enriched job metadata, then de-duplicates original upstream URLs across sources |
| [UKVisaJobs](/docs/next/extractors/ukvisajobs) | UK visa sponsorship-focused roles | Requires authenticated session and periodic token/cookie refresh | `UKVISAJOBS_EMAIL`, `UKVISAJOBS_PASSWORD`, `UKVISAJOBS_MAX_JOBS`, `UKVISAJOBS_SEARCH_KEYWORD` | API pagination + dataset output; orchestrator de-dupes and may fetch missing descriptions |
| [Manual Import](/docs/next/extractors/manual) | One-off jobs not covered by scrapers | Inference quality depends on model/provider and input quality; some URLs cannot be fetched reliably | App/API endpoints (`/api/manual-jobs/infer`, `/api/manual-jobs/import`) | Accepts text/HTML/URL, runs inference, then saves and scores job after review |
| [Tech in Asia Jobs](/docs/next/extractors/techinasia) | Indonesian startup and tech roles with published salaries | Indonesia only; public JSON API, no credentials | existing pipeline `searchTerms`, cities, `jobspyResultsWanted` | Full descriptions from the search API, rupiah salary ranges, Indonesian location evidence; cities filtered client-side; polite paging with a delay between requests |
| [Kalibrr](/docs/next/extractors/kalibrr) | Broad Indonesian job board coverage | Indonesia only; upstream keyword matching is loose, so job-ops filters results locally | existing pipeline `searchTerms`, cities, `jobspyResultsWanted` | Keeps only jobs whose title matches every search word (with tech-role synonyms); cities sent to Kalibrr's location filter; full description plus qualifications |
| [Dealls](/docs/next/extractors/dealls) | Indonesian startup roles and internships | Indonesia only; one detail request per new job | existing pipeline `searchTerms`, cities, `jobspyResultsWanted` | Skips detail requests for job links already in job-ops; cities filtered client-side; monthly rupiah salaries; adds the country to city-only locations |
| [JobStreet](/docs/next/extractors/jobstreet) | The largest Indonesian job board, newest jobs first | Indonesia only; one detail request per new job; robots.txt disallows the API paths, so keep it to personal, low-volume use | existing pipeline `searchTerms`, cities, workplace type, `jobspyResultsWanted` | Cities and a narrower workplace choice sent to JobStreet's own filters; titles matched to terms locally; rupiah salary labels parsed into amounts |
| [Glints](/docs/next/extractors/glints) | Indonesian tech and startup roles, including internships | Indonesia only; without login only the first page (up to 50 jobs) per term is served; one detail request per new job | existing pipeline `searchTerms`, cities, workplace type, `jobspyResultsWanted` | Descriptions converted from Glints' rich-text format; structured salary and work arrangement; titles matched to terms locally; cities filtered locally |
| [Indonesia Big Tech](/docs/next/extractors/idbigtech) | Openings at Grab, GoTo, TikTok/Tokopedia, Shopee, Traveloka, tiket.com, Blibli and Xendit | Indonesia only; reads each company's public career site; one failing company does not stop the others | existing pipeline `searchTerms`, cities, `jobspyResultsWanted`; enabled companies in **Settings → Workspace Access** | Real company as employer; titles matched to terms locally; detail requests only for new Grab, Traveloka and tiket.com jobs |

## Which extractor should I use?

- Use **JobSpy** for broad first-pass sourcing across common boards.
- Use **Adzuna** when you want API-first discovery in supported non-UK markets.
- Use **Hiring Cafe** when you want another term/country-driven source without adding credentials.
- Use **startup.jobs** when you want startup-heavy listings without maintaining another scraper locally.
- Use **Working Nomads** when you want another remote-only source with a public API and curated global roles.
- Use **Golang Jobs** when you want a niche Go-focused board that broad aggregators often miss.
- Use **Jobindex** when targeting Denmark roles from the local Jobindex board.
- Use **Seek** when targeting Australia/NZ roles via the Apify-powered Seek scraper.
- Use **FreeHire** for broad API-backed coverage without another credential.
- Use **Gradcracker** when targeting graduate pipelines in the UK.
- Use **UKVisaJobs** for sponsorship-specific UK searches.
- Use **Manual Import** when you already have a specific posting and need direct import.
- Use **Tech in Asia Jobs**, **Kalibrr**, **Dealls**, **JobStreet** and **Glints** when targeting Indonesia (select Indonesia as the country to see them). Add **Indonesia Big Tech** to check the career sites of the big Indonesian tech companies directly.

Many runs combine sources: broad discovery first, then manual import for high-priority jobs that scraping misses.

## Common problems

### How do I health-check an extractor?

- Every runtime-registered extractor source exposes `GET /api/:source/health`.
- Use the source id from the shared extractor catalog, for example `/api/linkedin/health` or `/api/gradcracker/health`.
- The health check runs a minimal live probe for that source with a fixed search term and a result limit of `1`.
- A `200` response means the extractor returned at least one valid normalized job for that source.
- A `503` response means the extractor could not run successfully, returned no jobs, or returned invalid jobs.
- A `404` response means the source id is unknown or not registered at runtime on that instance.

## Related extractor docs

- [Gradcracker](/docs/next/extractors/gradcracker)
- [JobSpy](/docs/next/extractors/jobspy)
- [Adzuna](/docs/next/extractors/adzuna)
- [Hiring Cafe](/docs/next/extractors/hiring-cafe)
- [startup.jobs](/docs/next/extractors/startup-jobs)
- [Working Nomads](/docs/next/extractors/working-nomads)
- [Golang Jobs](/docs/next/extractors/golang-jobs)
- [Jobindex](/docs/next/extractors/jobindex)
- [Seek](/docs/next/extractors/seek)
- [FreeHire](/docs/next/extractors/freehire)
- [UKVisaJobs](/docs/next/extractors/ukvisajobs)
- [Manual Import](/docs/next/extractors/manual)
- [Tech in Asia Jobs](/docs/next/extractors/techinasia)
- [Kalibrr](/docs/next/extractors/kalibrr)
- [Dealls](/docs/next/extractors/dealls)
- [JobStreet](/docs/next/extractors/jobstreet)
- [Glints](/docs/next/extractors/glints)
- [Indonesia Big Tech](/docs/next/extractors/idbigtech)
- [Add an Extractor](/docs/next/workflows/add-an-extractor)
