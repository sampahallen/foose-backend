# Thrift Marketplace Backend

Express/Mongoose API for the ThriftGH marketplace. The backend lives in `src/` and exposes route groups under `/api`.

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and set at least:

```env
PORT=8000
MONGO_URI=your_mongodb_connection_string
JWT_ACCESS_SECRET=dev_access_secret
JWT_REFRESH_SECRET=dev_refresh_secret
CLIENT_URL=http://localhost:5173
API_PUBLIC_URL=http://localhost:8000
```

`REDIS_URL`, AWS, Paystack, and SMTP settings are optional for local endpoint testing. When Redis is missing, cache and shared rate-limit features fall back gracefully.

For deployment, set these public URLs so email verification links use the customer-facing frontend and OAuth callbacks use the public API:

```env
CLIENT_URL=https://your-frontend-domain.com
CLIENT_AUTH_CALLBACK_URL=https://your-frontend-domain.com/auth/callback
API_PUBLIC_URL=https://your-api-domain.com
```

If the frontend is deployed under a sub-path, set `CLIENT_BASE_PATH` or provide the full `CLIENT_AUTH_CALLBACK_URL`.
New verification emails use `CLIENT_URL` plus `CLIENT_BASE_PATH`; `API_PUBLIC_URL` is not embedded in those emails.

3. Start the API:

```bash
npm run dev
```

4. Health check:

```http
GET http://localhost:8000/api/health
```

## Hashtag Count Backfill

After deploying the shared hashtag collection for the first time, run this once with the production `MONGO_URI` configured:

```bash
npm run hashtags:rebuild
```

The command is idempotent. It rebuilds exact counts from active/sold listings and all Finspo posts, creates records for previously unseen saved tags, and resets tags with no remaining posts to zero.

## Marketplace Location Backfill

Shop and listing locations are backfilled automatically after MongoDB connects. To rerun the same idempotent migration manually, use:

```bash
npm run locations:backfill
```

The migration fills an incomplete DigiShop location from its owner's account location, then snapshots that location onto legacy listings. Shops whose owner also lacks a complete city and region are reported and left unchanged. Search caches are cleared when records change.

## REST Client Tests

Install the VS Code extension **REST Client** by Huachao Mao, then open files in `rest-client/` and click **Send Request** above any request.

Recommended order:

1. `01-auth.http`
2. `02-users.http`
3. `03-kyc.http`
4. Approve KYC with `13-admin.http` using a KYC reviewer or super admin account
5. `04-digishops.http`
6. `05-listings.http`
7. Continue through orders, payments, reviews, community, chat, and notifications

Most files use these variables:

```http
@baseUrl = http://localhost:8000/api
@accessToken = paste_access_token_here
@refreshToken = paste_refresh_token_here
```

After login or register, copy `data.tokens.accessToken` and `data.tokens.refreshToken` into the variables at the top of the file you are testing.

For upload requests, replace sample file paths such as `C:\Users\User\Pictures\id.jpg` with real local image files.

## Useful Notes

- All money values are integers in pesewas.
- Protected routes need `Authorization: Bearer {{accessToken}}`.
- Password registration requires a city and one of Ghana's 16 regions.
- New password and OAuth registrations use the offline `disposable-email-domains` dataset plus the local overrides in `src/constants/disposableEmailDomains.js`; existing accounts are not retroactively blocked.
- Unverified active accounts may log in, browse, and save favorites. Email verification is required for messaging, checkout/payment initialization, publishing listings, and opening a DigiShop.
- Signed-in users can request a fresh link with `POST /api/auth/resend-verification`; the endpoint is limited to five requests per 15 minutes.
- KYC and payment state are intentionally not cached.
- DigiShop creation requires approved KYC.
- User roles are stored in the embedded `roles` object. Use `src/constants/roles.js` for role keys, codes, and dot paths; for example, super admin is `roles.superAdmin = USER_ROLES.SUPER_ADMIN`.
