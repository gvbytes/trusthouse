# TrustHouse — India's Identity and Trust Platform

TrustHouse connects household workers (cooks, cleaners, babysitters) with urban households, using verified digital identity via eKYC (Aadhaar/Persona), a digital QR ID card, and automated payouts with replacement worker routing.

---

## Quickstart Setup

### 1. Prerequisites
Make sure [Node.js](https://nodejs.org) (v20+) and `npm` are installed.

### 2. Installation
Clone or navigate to the project directory and install the packages:
```bash
npm install
```

### 3. Environment Secrets Config
Copy the `.env.example` file and configure it as `.env`:
```bash
cp .env.example .env
```
Ensure that the `ENCRYPTION_KEY` and `JWT_SECRET` variables are set. You can use the pre-generated values inside the pre-populated `.env` file for local development.

### 4. Running the Dev Servers
You can run both the Express backend and the Vite client concurrently.

Build the frontend bundle first:
```bash
npm run build
```

Then start the server:
```bash
npm start
```
The server will boot and serve the API routes on `http://localhost:5000`, while serving the built PWA client statically.

---

## Dev Sandbox Playground Credentials

To make local evaluation frictionless, the system database is seeded with mock playground accounts. You can bypass live SMS dispatch and verify OTP authentication immediately by using these phone numbers and a constant verification code:

* **Constant Sandbox OTP**: `123456`
* **Admin Profile**: `9999900000`
* **Household Profile**: `9999911111` (Rohan Sharma)
* **Worker Profile (Verified)**: `9999922222` (Sunita Devi)
* **Worker Profile (Pending)**: `9999933333` (Ramesh Kumar)

---

## Queue Monitoring Dashboard

TrustHouse uses **Bull.js** and **Redis** for asynchronous task execution. Administrators can monitor job lifecycles (pending, active, completed, failed) via the **Bull Board** UI.

* **Dashboard URL**: `http://localhost:5000/admin/queues`
* **Access Control**: Authenticated Admin credentials required. Log in using sandbox admin number `9999900000` (OTP: `123456`) to obtain the JWT token, then include it as a `Bearer` token or use the UI session path.

### Background Processing Queues
1. `replacementEngine`: Automatically matches and dispatches on-call helpers when absences are reported.
2. `dailyPayouts`: Computes payouts and deducts platform commissions, executing IMPS transactions via Razorpay X.
3. `kycVerification`: Manages biometric inquiries and documents collection with Persona.
4. `idCardDispatch`: Generates PDF copies of QR-coded credentials and coordinates courier shipping.
5. `notifications`: Sends WhatsApp alerts and transaction SMS receipts via Fast2SMS.
6. `scheduledJobs`: Handles recurring cron jobs (daily confirmations, loyalty checkpoints).

---

## Security Practices

* **Dependency Auditing**: Ensure packages remain secure. Run audits regularly before production pushes:
  ```bash
  npm audit
  ```
* **PII Protection**: Aadhaar, PAN, and bank data are encrypted at rest using AES-256-GCM.
* **Deny-by-Default Access Control**: Every endpoint verifies JWT tokens and enforces role restrictions.
