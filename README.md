# VELOBOX

VELOBOX locker operations app with a Node.js HTTP API and SQLite persistence.

## Requirements

- Node.js 24 or newer (uses the built-in `node:sqlite` module)

## Run locally

```powershell
node server.mjs
```

Open <http://127.0.0.1:4173>. On first launch, create the initial system administrator. The database is created as `velobox.sqlite` beside `server.mjs`; it starts empty and is excluded from Git.

Set `PORT` to choose another port, `HOST` to set the bind address, or `VELOBOX_DB` to store the SQLite file elsewhere.

## Deploy to Render

This repository includes a Render Blueprint at [render.yaml](render.yaml). In Render, choose **New → Blueprint**, connect this GitHub repository, review the service and persistent disk, then deploy. Render assigns the public `onrender.com` URL after deployment. The SQLite database is stored on a persistent disk mounted at `/var/data`; the blueprint uses the Starter service plan because Render persistent disks require a paid service. The sanitized `velobox_schema_only.sqlite` is not used as the live database: the app creates an empty operational database on first start.

## Included backend

- Cookie-based login sessions and first-run administrator setup
- Password hashing with Node.js `scrypt`
- Role checks for system administrator, building administrator, shipper, and resident
- API-backed orders, stations, locker cells, incidents, payment intents, users, integrations, and audit events
- One-time OTP generation and server-side OTP hash verification for locker pickup
- SQLite persistence with foreign-key constraints

## External services

Payment collection, SMS/Zalo notifications, AI chatbot, and physical locker control require provider credentials or an IoT gateway. The app records configuration and relevant operations but does not claim to perform those external actions until they are connected.

## Security note

This is an early deployment prototype. Before real customer use, add rate limiting, CSRF protections appropriate to the deployment, session revocation/rotation, operational backups, and provider-specific webhook signature verification.

## Sanitized SQLite artifact

`velobox_schema_only.sqlite` contains the VELOBOX table schema with all tables empty. It is for schema inspection only; the local operational database is excluded from the repository.
