# Publish to Instagram Reels and Facebook Reels

One free **Meta developer app** and one Facebook login connect both platforms. Development mode is enough for
your own accounts — no Meta review needed.

## Before you start
- Your Instagram must be a **Business or Creator** account (Instagram app → Settings → Account type).
- You need a **Facebook Page**, and the Instagram account must be **linked to it**
  (Page → Settings → **Linked accounts → Instagram → Connect**).

## 1. Create the Meta app
1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) with the Facebook account that manages
   your Page → **Create app**. Name `Clipora`, your email.
2. **Use cases:** tick **Manage everything on your Page** and **Manage messaging & content on Instagram**
   (the Facebook-login variant). Business portfolio: *I don't want to connect one yet*. **Create app**.
3. **Facebook Login for Business → Configurations → Create configuration:**
   - Login variation **General**, access token **User access token**
   - Assets: **Pages** and **Instagram accounts**
   - Permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`,
     `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `business_management`
   - Create, then copy the **Configuration ID**.
4. **Redirect URI:** in Development mode, `http://localhost` redirects are allowed automatically — nothing to add.
   For your own domain, add `https://YOUR-DOMAIN/api/connect/meta/callback` under Facebook Login → Settings.
5. **App settings → Basic:** copy the **App ID** and **App secret** (*Show*).
6. Secrets / `clipora.env`:
   ```
   META_APP_ID=...
   META_APP_SECRET=...
   META_CONFIG_ID=...
   ```

## 2. Connect in Clipora
1. **Connections → Connect with Facebook → Open Facebook sign-in.**
2. Choose **your Page** and **your Instagram account**, keep all permissions on, continue.
3. Copy the address of the *"can't be reached"* page you land on, paste it into Clipora → **Finish connecting**.
4. Optional: **Save it as a secret** → `META_TOKEN=...` in `clipora.env` (valid about 60 days).

## Limits you should know
- **Facebook Reels: 3–90 seconds.** Instagram Reels: 3 seconds – 15 minutes.
- **Instagram: about 50 API posts per 24 hours.** Clipora checks the remaining quota before uploading.
- Posting many Reels quickly — especially **reposted content** — can make Instagram block posting for hours or days.
  Clipora spaces Meta posts at least 2 minutes apart; post fewer clips per day and prefer your own content.
- Instagram/Facebook **schedules are sent by Clipora itself**, so the site must be running at that time.

## Troubleshooting
Click a red **"… failed · Why?"** badge on a clip to see Meta's exact message.

| Message | Fix |
|---|---|
| *A permission is missing* | Add every permission above to the Configuration, then Disconnect and Connect again. |
| *No Instagram account is linked* | Link Instagram to the Page (Page settings → Linked accounts), then Connect again and tick it. |
| *blocked as possible spam* / *posting limit* | Wait (usually 24–48 h), post fewer clips, avoid reposting other creators. |
| *token expired* | Connect again and save the new `META_TOKEN`. |
