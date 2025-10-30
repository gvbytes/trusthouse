# TrustHouse Security Threat Model (STRIDE & OWASP API 2026)

This document outlines the architectural threat model for the TrustHouse platform, detailing vectors, asset exposures, and concrete code controls implemented.

---

## Secrets Management Policy

* **Zero Hardcoded Credentials**: Absolutely no API keys, webhooks secrets, or cryptoprimitive keys exist in the codebase.
* **Environment Sourcing**: Loaded strictly from `.env` on runtime execution via `process.env`.
* **Git Safeguard**: A strict [`.gitignore`](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/.gitignore) prevents local configuration leaks to upstream repositories.

---

## Threat Matrix: STRIDE & OWASP Mapping

### 1. Spoofing Identity / Broken Authentication (OWASP API #2)
* **Attack Vectors**:
  * OTP brute-force attacks via automation scripts to hijack worker profiles.
  * SMS pumping fraud generating massive gateway costs.
* **TrustHouse Asset**: SMS API balance, Worker sessions, and PII.
* **Implemented Mitigations**:
  * **Hashed Verification**: OTPs are generated and hashed server-side using SHA-256 via [auth.js:hashString()](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/auth.js). Client receives only the verification result.
  * **Rate Limiting**: Enforced via PostgreSQL database query checks in [auth.js:requestOTP()](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/auth.js). Max 3 sends per phone number per 15-minute sliding window. Max 5 verification attempts before invalidating the session.
  * **IP Limiting**: Express middleware [server.js:authLimiter](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js) throttles connection requests to 15 per 15 minutes.

### 2. Tampering / Injection & Integrity Failures (OWASP API #5, #8)
* **Attack Vectors**:
  * SQL Injection in auth/profile routes to dump PostgreSQL database tables.
  * Payloads tampering with callback results (e.g. spoofing Razorpay paid webhook or Persona KYC webhook).
* **TrustHouse Asset**: System Database, KYC Approval State, Payout Transaction records.
* **Implemented Mitigations**:
  * **Strict Parameterization**: Implemented via native Prisma Client queries which parameterize all SQL queries by default. No raw string concatenations are used.
  * **Webhook HMAC Signature Verification**:
    * **Persona**: Verified via HMAC-SHA256 signature in [kyc_agent.js:verifyPersonaSignature()](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/agents/kyc_agent.js). Payload matching timing-safe evaluation timing blocks spoofed approval triggers.
    * **Razorpay**: Checked via HMAC-SHA256 matching signature check in [server.js:razorpayWebhook](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js).

### 3. Repudiation / Security Logging Failures (OWASP API #10)
* **Attack Vectors**:
  * Malicious users executing billing chargebacks or faking attendance checkout claims without audit logs.
* **TrustHouse Asset**: Financial reconciliation and accountability.
* **Implemented Mitigations**:
  * **Strict Audit Trail**: Important events (logins, check-ins, payouts, KYC decisions) write structured entries into the `AuditLog` table via [db.js](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/db.js).
  * **No PII Logging**: Sensitive elements (raw Aadhaar numbers, unmasked bank details, OTP codes) are filtered out and never write to log lines.

### 4. Information Disclosure / Cryptographic Failures (OWASP API #3)
* **Attack Vectors**:
  * Leaking full Aadhaar/PAN digits inside debug error tracebacks or admin API returns.
* **TrustHouse Asset**: Worker Identity numbers, bank accounts.
* **Implemented Mitigations**:
  * **AES-256-GCM Encryption**: Full Aadhaar strings are encrypted at rest using [crypto_helper.js:encrypt()](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/crypto_helper.js).
  * **Masked Display**: Profile calls return only masked versions (e.g. `XXXX-XXXX-1234`) via [server.js:profile](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js).
  * **No Verbose Errors**: Unhandled errors trigger a generic safe response in the global Express error handler [server.js:GlobalErrorHandler](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js).

### 5. Denial of Service / Security Misconfiguration (OWASP API #7)
* **Attack Vectors**:
  * Exploiting cross-site scripting (XSS) or framing endpoints to hijack sessions.
* **TrustHouse Asset**: Frontend user session trust and platform availability.
* **Implemented Mitigations**:
  * **Helmet Integration**: Implemented via [server.js](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js) setting HSTS, X-Frame-Options, X-Content-Type-Options, and a robust Content Security Policy (CSP) blocking external script injection.
  * **Global Rate Limiting**: Limit connection spikes to 100 requests per 15 minutes via [server.js:globalLimiter](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js).

### 6. Elevation of Privilege / Broken Access Control (OWASP API #1)
* **Attack Vectors**:
  * Workers altering endpoint IDs to access other workers' payout or profile information.
  * Households calling admin API endpoints.
* **TrustHouse Asset**: Access scopes to database objects.
* **Implemented Mitigations**:
  * **Deny-by-Default Middleware**: Authenticated token decryption in [auth.js:authenticateToken](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/auth.js).
  * **Role Constraints**: Endpoint protection middleware via `requireRole(['role_name'])` checks in [server.js](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js). Workers are strictly banned from admin tools.

### 7. Insecure Design & Abuse Case Modeling
* **Abuse Case A: Free Labor Extraction** (Household orders worker and cancels repeatedly):
  * *Control*: Razorpay payouts deduct standard rates, order is captured upfront and validated server-side on creation via [server.js:bookings/create](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js).
* **Abuse Case B: Worker Faking Attendance**:
  * *Control*: Attendance checks require dual check-in and check-out logs matched against booked slot times in [server.js:attendance](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js).
* **Abuse Case C: Scraper Harvesting Public Directory**:
  * *Control*: Public verification route `/api/verify/:workerCode` has restricted field outputs (no coordinates, phone, or raw ID numbers) and strict rate limits in [server.js:publicVerifyLimiter](file:///C:/Users/Jay%20Prakash%20Verma/.gemini/antigravity/scratch/trusthouse/server/server.js).

### 8. AI prompt Injection (LLM Orchestrator Security)
* **Attack Vector**:
  * Malicious users crafting input descriptions (e.g. shift dispute forms) filled with prompt injection strings designed to alter execution flow of downstream autonomous Gemini agents.
* **TrustHouse Asset**: Autonomous dispatch matching state integrity.
* **Implemented Mitigations**:
  * Input fields are strictly sanitized and parsed on the Express layer. No raw, unescaped user text is fed directly into prompt variables of active dispatch agents.
