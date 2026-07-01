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

For deployment, set these public URLs so email verification links do not point to localhost:

```env
CLIENT_URL=https://your-frontend-domain.com
CLIENT_AUTH_CALLBACK_URL=https://your-frontend-domain.com/auth/callback
API_PUBLIC_URL=https://your-api-domain.com
```

If the frontend is deployed under a sub-path, set `CLIENT_BASE_PATH` or provide the full `CLIENT_AUTH_CALLBACK_URL`.

3. Start the API:

```bash
npm run dev
```

4. Health check:

```http
GET http://localhost:8000/api/health
```

## REST Client Tests

Install the VS Code extension **REST Client** by Huachao Mao, then open files in `rest-client/` and click **Send Request** above any request.

Recommended order:

1. `01-auth.http`
2. `02-users.http`
3. `03-kyc.http`
4. Approve KYC with `13-admin.http` using an admin account
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
- KYC and payment state are intentionally not cached.
- DigiShop creation requires approved KYC.
- Admin routes require a user with `role: "admin"` in MongoDB.
