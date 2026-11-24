# Publish to YouTube Shorts

Clipora uploads with the official **YouTube Data API**. You create a free Google Cloud app once (about 15 minutes);
the keys stay with you.

## 1. Google Cloud app
1. Go to [console.cloud.google.com](https://console.cloud.google.com), sign in with the Google account that owns your
   channel, and **create a project** (e.g. `clipora`).
2. **APIs & Services → Library →** search **YouTube Data API v3** → **Enable**.
3. **Google Auth Platform** (OAuth consent screen):
   - **Branding:** app name `Clipora`, your support email, developer contact email. Leave the logo empty.
   - **Audience:** user type **External**. Under **Test users → Add users**, add the Gmail you'll sign in with.
   - **Data access → Add or remove scopes:** `.../auth/youtube.upload` and `.../auth/youtube.readonly` → Update → Save.
4. **Clients → Create client → Web application**:
   - **Authorized redirect URIs:** `http://localhost:8000/api/connect/youtube/callback`
     (and later `https://YOUR-DOMAIN/api/connect/youtube/callback` if you host Clipora on your own domain).
   - Copy the **Client ID** and **Client secret** (the secret is only shown once; *Add secret* makes a new one).
5. Put them in your secrets / `clipora.env`:
   ```
   YOUTUBE_CLIENT_ID=....apps.googleusercontent.com
   YOUTUBE_CLIENT_SECRET=GOCSPX-...
   ```

## 2. Connect in Clipora
1. **Connections → Connect YouTube → Open Google sign-in.** Pick your account, and the right channel if Google asks.
2. Google says *"Google hasn't verified this app"* — it's your own app: **Advanced → Go to Clipora (unsafe) → Continue**,
   and allow all permissions.
3. You land on a `http://localhost:8000/...` page that says *"This site can't be reached"* — **that's expected on
   Kaggle/Colab.** Copy the whole address from the address bar, paste it into Clipora, click **Finish connecting**.
   (On your own computer or domain the page loads and finishes by itself.)
4. Optional: **Save it as a secret** → add the token to `clipora.env` as `YOUTUBE_REFRESH_TOKEN=...` so new
   sessions start connected.

## Limits you should know
- **Testing mode:** Google ends the connection every **7 days**. To stop that, fill in Branding with a home page +
  privacy policy on your own domain and click **Publish app** (no Google review is needed for your own channel).
- **Private uploads:** apps Google hasn't audited may have uploads forced to **Private**. Switch them to Public in
  YouTube Studio, or apply for Google's free API audit.
- **Quota:** about **6 uploads per day** on the free quota. When it runs out, Clipora shows *waiting for quota* and
  uploads automatically after it resets (midnight US Pacific time) if the site is running.

## Troubleshooting
| Message | Fix |
|---|---|
| `access_denied` | The account isn't a **Test user**. Add it under Audience → Test users. |
| `redirect_uri_mismatch` | Add the exact redirect URI Clipora shows on the Connections card to your Google client. |
| Uploads went to another channel | Disconnect, connect again and pick the right channel (Brand accounts are listed separately). |
| Can't find uploads in Studio | Vertical clips under 3 minutes are listed under **Content → Shorts**, not Videos. |
