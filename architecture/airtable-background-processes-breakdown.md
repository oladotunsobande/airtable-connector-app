# Airtable Web App — Complete Background Process Breakdown
**App URL:** https://airtable.com/app7TK2tBb4DMDutd  
**Base:** Bug tracker | **Table:** Bugs and issues  
**Record:** Unable to open previously recorded videos (recvZ4C16Wj0pz3RG)  
**Analysis Date:** June 11, 2026  
**Navigation Path:** Homepage → Login Page → Base (Bug Tracker) → Record → Revision History  

---

## 1. Pre-Login Phase: Page Load Architecture

### 1.1 Rendering Framework
- **Framework:** React (Next.js + ESBuild bundler)
- **Rendering Strategy:** Server-Side Rendering (SSR) with client hydration
- **Build Hash:** `c13fea97` (used in all static asset URLs)
- **Deployment Hash (DPL):** `dpl_97x87PoHrvK8VyuZtJNekVtxNDhN`
- **Bundle Strategy:** 50+ lazy-loaded code-split chunks via ESBuild

### 1.2 JavaScript Chunk Loading (50+ chunks)
All static chunks loaded from:
```
https://static.airtable.com/esbuild/by_sha/c13fea97/br/chunks/chunk-{HASH}.js
```
Entry point for sign-in A/B variant:
```
GET https://static.airtable.com/esbuild/by_sha/c13fea97/br/client/entrypoints/run_signin_var_B.js
```

### 1.3 CSS Assets
```
GET https://static.airtable.com/css/compiled/v2/helpers.76254cfb833f0b0369b808ddfdb2d40cb9e7b9cf.css
```

---

## 2. Authentication & Security Layer

### 2.1 Cookie Consent Management (Dual Framework)

**Transcend (airgap.js + uiV2.js):**
```
GET https://transcend-cdn.com/cm/619e6e3b-1a5c-4516-be11-6d77bdcbd717/airgap.js
GET https://transcend-cdn.com/cm/619e6e3b-1a5c-4516-be11-6d77bdcbd717/uiV2.js
GET https://transcend-cdn.com/cm/619e6e3b-1a5c-4516-be11-6d77bdcbd717/uiV2/themes/airtable.css
GET https://transcend-cdn.com/cm/619e6e3b-1a5c-4516-be11-6d77bdcbd717/uiV2/translations/us-template-v01/en.json
POST https://telemetry.us.transcend.io/collect   → 503
```

Console sequence observed:
```
[LOG] Intellimize: Loading webflow loader
[LOG] Intellimize: Checking if in iframe
[LOG] Intellimize: Checking Transcend tcm cookie → hasOptedIn (tcm): false
[LOG] Intellimize: Checking OneTrust OptanonConsent cookie → hasOptedIn (OptanonConsent): true
[LOG] Intellimize: User has opted in
```

**Result:** OneTrust consent = TRUE → Intellimize personalization ACTIVATED

### 2.2 Bot Detection (PerimeterX)
```
GET  https://static.airtable.com/js/lib/perimeterx/v1/PX0OZADU9K/init.js
POST https://collector-px0ozadu9k.px-cloud.net/api/v2/collector  (×3, all 200 OK)
```
- **Sensor ID:** PX0OZADU9K
- Collects browser fingerprint, timing signals, behavioral data
- Fires on each page load and interaction

### 2.3 A/B Testing (Intellimize)
- Sign-in page loaded **Variant B**: `run_signin_var_B.js`
- Personalization activated based on OneTrust OptanonConsent cookie

### 2.4 Content Security Policy (CSP)
```
POST https://airtable.com/.csp/report  (×4 across session, all 200 OK)
```
- Airtable enforces strict CSP; violation reports sent to internal endpoint

### 2.5 JWT & Session Token Architecture
| Token/Cookie | Purpose | Storage |
|---|---|---|
| `__Host-airtable-session` | Session JWT (HttpOnly, Secure) | Cookie |
| `__Host-airtable-session.sig` | HMAC signature for session | Cookie |
| `AWSALB` / `AWSALBCORS` | AWS ALB sticky session routing | Cookie |
| `OptanonConsent` | OneTrust consent preferences | Cookie |
| `_px3` | PerimeterX behavioral risk token | Cookie |
| `_px2` | PerimeterX human verification | Cookie |
| `fbp` | Facebook Pixel tracking | Cookie |
| Authorization Bearer | Authenticated API JWT | Request Header |

### 2.6 Authenticated Request Headers Pattern
```http
GET /v0.3/row/{rowId}/readDataForDetailView HTTP/2
Host: airtable.com
Cookie: __Host-airtable-session=<JWT>; _px3=<token>; ...
X-Requested-With: XMLHttpRequest
Accept: application/json
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
```

---

## 3. Authenticated App APIs (Live Captured)

### 3.1 Application Data Load
```http
GET /v0.3/application/app7TK2tBb4DMDutd/read?
  stringifiedObjectParams={"includeDataForTableIds":["tblQWzYAWyuDyM255"],
  "includeDataForViewIds":null,
  "shouldIncludeSchemaChecksum":false,
  "mayOnlyIncludeRowAndCellDataForIncludedViews":true,
  "mayExcludeCellDataForLargeViews":true,
  "allowMsgpackOfResult":true,
  "canClientSupportPreviewMode":true}
  &requestId=reqYaTQixSBeXL2NG
  &secretSocketId=socwzrGrV6q0AgOqU
→ 200 OK
```
- Loads the full base schema, table metadata, and visible record data
- `secretSocketId` links to real-time WebSocket session
- Supports msgpack compression for efficiency

### 3.2 User Identity & Applications
```http
GET /v0.3/user/usrJaGzrl4gMmZfNM/listApplicationsAndPageBundlesForDisplay?
  stringifiedObjectParams={"shouldIncludePageBundleSharingApplications":true,
  "shouldIncludePageBundleIndex":true}
  &requestId=reqtNgY7vY2CUbwa8
→ 200 OK
```
- Fetches all workspaces/bases accessible to authenticated user
- **Observed User ID:** `usrJaGzrl4gMmZfNM`

### 3.3 User Favorites
```http
GET /v0.3/user/usrJaGzrl4gMmZfNM/getFavorites?
  stringifiedObjectParams={}
  &requestId=reqWbuxFPv2T8eSRJ
→ 200 OK
```

### 3.4 Real-Time Socket Info (Polling)
```http
GET /singleApplicationRealtime/withCompression/info?
  applicationId=app7TK2tBb4DMDutd
  &transactionNumber=6
  &t={timestamp}
→ 200 OK  (fires every 10 seconds)
```
- Long-polling mechanism for real-time collaboration
- Returns WebSocket upgrade info or polling fallback
- `transactionNumber=6` tracks sync state

### 3.5 Record Detail View
```http
GET /v0.3/row/recvZ4C16Wj0pz3RG/readDataForDetailView?
  stringifiedObjectParams={"includeParentTableData":false,
  "includeOnlyFirstNonFormViewForForeignTables":true,
  "includeLocalRowData":true,
  "excludeDataForForeignRows":true,
  "shouldUseNestedResponseFormat":true}
  &requestId=reqfeBsAoGjVzANWG
  &secretSocketId=socwzrGrV6q0AgOqU
→ 200 OK
```
- **Record ID:** `recvZ4C16Wj0pz3RG`
- Loads all fields for expanded record view
- Includes linked records with nested format

### 3.6 Comment Summary (Pre-load)
```http
GET /v0.3/row/recvZ4C16Wj0pz3RG/readCommentSummary?
  stringifiedObjectParams={"summaryType":"commentsOnly"}
  &requestId=reqgxF1lekaKCPqDX
  &secretSocketId=socwzrGrV6q0AgOqU
→ 200 OK
```

### 3.7 Record Comments (Paginated)
```http
GET /v0.3/row/recvZ4C16Wj0pz3RG/readRowComments?
  stringifiedObjectParams={"cursor":null,
  "limit":10,
  "shouldIncludeOnlyRowLevelComments":false,
  "shouldIncludeRowActivityOrCommentUserObjById":true}
  &requestId=req220qdyUVHVATSK
  &secretSocketId=socwzrGrV6q0AgOqU
→ 200 OK
```

### 3.8 ⭐ REVISION HISTORY (Activities & Comments Combined)
```http
GET /v0.3/row/recvZ4C16Wj0pz3RG/readRowActivitiesAndComments?
  stringifiedObjectParams={"limit":10,
  "offsetV2":null,
  "shouldReturnDeserializedActivityItems":true,
  "shouldIncludeRowActivityOrCommentUserObjById":true}
  &requestId=reqkBbYV89vMsfGgK
  &secretSocketId=socwzrGrV6q0AgOqU
→ 200 OK
```
**This is the core Revision History endpoint!** Parameters explained:
- `shouldReturnDeserializedActivityItems:true` → Returns human-readable field change descriptions
- `shouldIncludeRowActivityOrCommentUserObjById:true` → Includes user metadata for each revision
- `limit:10` → Paginated results (load more with `offsetV2`)
- Response includes: field name, old value, new value, timestamp, user ID

### 3.9 Feature Flag Check (Revision History)
```http
GET /v0.3/application/app7TK2tBb4DMDutd/getClientSideContextForFeatureFlag?
  stringifiedObjectParams={"featureFlagName":"redactSyncCellHistory"}
  &requestId=req1279ZzZnrcntQb
→ 200 OK
```
- Checks if `redactSyncCellHistory` feature flag is enabled
- Controls whether sync-source field changes are shown in revision history

### 3.10 Linked Record Row Cards (Lookup Fields)
```http
POST /v0.3/table/tbldui7VwuHBwXwEM/readDataForRowCards
POST /v0.3/table/tblIVb1Roq0IlJI0K/readDataForRowCards
→ 200 OK (×3, each for different linked tables)
```
- Loads linked record data for display in expanded record view

---

## 4. Internal Telemetry APIs

| Endpoint | Method | Purpose | Status |
|---|---|---|---|
| `/internal/page_view` | POST | Page navigation analytics | 503 (server) |
| `/internal/beacon-batch` | POST | Batched performance/UX telemetry | 503 (server) |
| `/internal/stats-batch` | POST | Feature usage statistics | 503 (server) |
| `/internal/tracing` | POST | Distributed tracing for observability | 200 OK |
| `/internal/log` | POST | Client-side error logging | 200 OK |
| `/internal/exposures` | POST | Feature flag exposure tracking | 503 (server) |

---

## 5. Third-Party Analytics & Tracking

### 5.1 Google Tag Manager
```
GET https://www.googletagmanager.com/gtm.js?id=GTM-NCLXNTS
```
- **Container ID:** GTM-NCLXNTS
- Manages all third-party tag firing

### 5.2 Google Analytics 4 (GA4)
```
GET  https://www.googletagmanager.com/gtag/js?id=G-VJY8J9RFZM
POST https://analytics.google.com/g/collect?v=2&tid=G-VJY8J9RFZM&en=page_view → 503
POST https://analytics.google.com/g/collect?v=2&tid=G-VJY8J9RFZM&en=scroll → 503
```
- **Measurement ID:** G-VJY8J9RFZM
- **Client ID (cid):** 183703236.1780955765
- **Session ID (sid):** 1781224689
- Events: `page_view`, `scroll` (90% depth)

### 5.3 Facebook Pixel
```
GET https://www.facebook.com/tr/?id=418406606004092&ev=PageView ... → 200 OK (×4)
```
- **Pixel ID:** 418406606004092
- **FBP Cookie:** fb.1.1780957277228.326237744364951742
- Fires on every page navigation (PageView events)
- Also sends Privacy Sandbox registration

### 5.4 Google Ads Audiences
```
GET https://www.google.ca/ads/ga-audiences?... → 200 OK
```
- Remarketing pixel for Google Ads audience building

### 5.5 Twitter Ads Pixel
```
GET https://analytics.twitter.com/i/adsct?txn_id=l6gpl&p_id=Twitter → 200 OK
```
- **Pixel ID:** l6gpl

### 5.6 LinkedIn Insight Tag
```
POST https://px.ads.linkedin.com/wa/?medium=fetch&fmt=g → 503 (×5)
```
- LinkedIn conversion tracking (server returning 503)

### 5.7 Marketo (B2B Lead Tracking)
```
GET https://munchkin.marketo.net/165/munchkin.js
```
Console: `Munchkin.init("%s") options: 458-JHQ-131 Object`
- **Marketo Instance ID:** 458-JHQ-131
- B2B marketing automation tracking

---

## 6. Console Events & Errors

### 6.1 Initialization Logs
| Time | Level | Message |
|---|---|---|
| 6:38:09 PM | LOG | Intellimize: Loading webflow loader |
| 6:38:09 PM | LOG | Intellimize: Checking Transcend tcm cookie |
| 6:38:09 PM | LOG | Intellimize: hasOptedIn (tcm) false |
| 6:38:09 PM | LOG | Intellimize: Checking OneTrust OptanonConsent cookie |
| 6:38:09 PM | LOG | Intellimize: hasOptedIn (OptanonConsent) true |
| 6:38:09 PM | LOG | Intellimize: User has opted in |

### 6.2 Runtime Exceptions
| Time | Level | Source | Error |
|---|---|---|---|
| 6:39:32 PM | EXCEPTION | gtm.js | `ReferenceError: gtag is not defined` — race condition |
| 6:39:54 PM | EXCEPTION | chunk-K4J5EEFW.js | React Error #425 — SSR hydration mismatch |
| 6:39:54 PM | EXCEPTION | chunk-K4J5EEFW.js | React Error #418 (×5) — content mismatch |
| 6:39:54 PM | EXCEPTION | chunk-K4J5EEFW.js | React Error #423 — hydration reconciliation |
| 6:40:03 PM | DEBUG | munchkin.js | Marketo init: 458-JHQ-131 |

### 6.3 i18n Warning
```
react-i18next:: useTranslation: You will need to pass in an i18next instance
```

---

## 7. Step-by-Step Process Breakdown

### Step 1: Homepage Load (airtable.com)
1. Next.js SSR renders homepage HTML
2. CSS helpers, fonts (Source Sans 3), polyfills loaded
3. GTM container (GTM-NCLXNTS) fires
4. GA4 (G-VJY8J9RFZM) loads → `page_view` fires → 503
5. PerimeterX (PX0OZADU9K) init → bot fingerprinting
6. Transcend consent manager loads → OneTrust cookie checked → opted in
7. Intellimize personalization activated
8. Twitter, Google Ads pixels fire
9. `/internal/page_view` beacon fires with pageLoadId
10. 50+ JavaScript chunks lazy-loaded

### Step 2: Login Page (airtable.com/login)
1. Client-side navigation (no full reload)
2. `run_signin_var_B.js` loaded → A/B Variant B selected
3. React SSR hydration begins → hydration errors (#418, #423, #425)
4. PerimeterX sends 3 POST requests to px-cloud.net
5. New `/internal/page_view` fires for /login
6. GA4 `page_view` + `scroll` (90%) fire → both 503
7. CSP violation reports (×2) POST to /.csp/report
8. Beacon batch + stats-batch telemetry fire → 503
9. i18next warning logged (init race condition)

### Step 3: Login Page Rendered
Login options: Email/Password, SSO, Google OAuth, Apple OAuth

### Step 4: Post-Authentication (App Load)
1. JWT session cookie (`__Host-airtable-session`) set
2. PerimeterX `_px3` risk token set
3. `/v0.3/application/{appId}/read` → Full base schema + records loaded
4. `/v0.3/user/{userId}/listApplicationsAndPageBundlesForDisplay` → Workspace list
5. `/v0.3/user/{userId}/getFavorites` → User favorites
6. `/singleApplicationRealtime/withCompression/info` → Real-time polling starts (10s intervals)
7. Facebook Pixel PageView fires (×1)
8. Marketo Munchkin loads: 458-JHQ-131

### Step 5: Opening Record (recvZ4C16Wj0pz3RG)
1. Client-side route update → URL includes record ID
2. `/v0.3/row/{rowId}/readDataForDetailView` → All record fields loaded
3. `/v0.3/row/{rowId}/readCommentSummary` → Comment count pre-loaded
4. `/v0.3/row/{rowId}/readRowComments` → First 10 comments loaded
5. `/v0.3/table/{tableId}/readDataForRowCards` → Linked records data (×3)
6. Facebook Pixel PageView fires (×2, for record URL)
7. `/internal/page_view` fires → 503

### Step 6: ⭐ Accessing Revision History (Activity Panel)
1. Click on activity/comments panel icon (chat bubble)
2. **`/v0.3/row/{rowId}/readRowActivitiesAndComments`** fired:
   - Returns paginated field change history
   - Each revision includes: field name, old value, new value, timestamp, userId
   - `shouldReturnDeserializedActivityItems:true` → human-readable descriptions
3. **`/v0.3/application/{appId}/getClientSideContextForFeatureFlag?featureFlagName=redactSyncCellHistory`** → Checks if sync history is redacted
4. `/internal/tracing` → Performance trace recorded (200 OK)

---

## 8. Infrastructure Observations

| Component | Details |
|---|---|
| **CDN** | Airtable static CDN (`static.airtable.com`) |
| **Load Balancer** | AWS ALB (inferred from AWSALB/AWSALBCORS cookies) |
| **Auth** | JWT + HttpOnly cookies + HMAC signature |
| **Real-time** | Long-polling via `/singleApplicationRealtime/withCompression/info` (10s) |
| **Analytics** | GA4 (G-VJY8J9RFZM) via GTM (GTM-NCLXNTS) |
| **Consent** | Transcend (airgap.js) + OneTrust (OptanonConsent) dual framework |
| **Bot Defense** | PerimeterX (PX0OZADU9K) |
| **A/B Testing** | Intellimize (via webflow_loader.js) |
| **SSR** | Next.js (React) |
| **Bundler** | ESBuild (build hash: c13fea97) |
| **Fonts** | Google Fonts (Source Sans 3, woff2) |
| **Ads/Marketing** | Twitter Pixel (l6gpl), Google Ads, Facebook Pixel (418406606004092), LinkedIn Insight, Marketo (458-JHQ-131) |

---

## 9. HTTP Status Summary

| Status | Count | Meaning |
|---|---|---|
| 200 OK | ~85 | Successful requests |
| 503 | ~25 | Server-side errors (GA4, telemetry endpoints, LinkedIn, Transcend) |

---

## 10. Key API Parameters Reference

### Revision History API
```
GET /v0.3/row/{rowId}/readRowActivitiesAndComments
  stringifiedObjectParams:
    limit: 10                                     → Page size
    offsetV2: null                                → Pagination cursor
    shouldReturnDeserializedActivityItems: true   → Human-readable changes
    shouldIncludeRowActivityOrCommentUserObjById: true → Include user metadata
  requestId: {unique-per-request}
  secretSocketId: {websocket-session-id}
```

### Request IDs Pattern
All API calls include a `requestId` parameter (e.g., `reqkBbYV89vMsfGgK`).  
Format: `req` + alphanumeric string. Used for request tracing/deduplication.

### Socket ID
All authenticated data calls include `secretSocketId=socwzrGrV6q0AgOqU`.  
This links API calls to the user's real-time collaboration session.

---

*Report generated by monitoring all network requests, headers, cookies, console events, and API calls while navigating to revision history on June 11, 2026.*
