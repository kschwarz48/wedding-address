# Kevin & Casey: wedding address form

An elegant address form hosted free on GitHub Pages. Each submission becomes one row in a Google Sheet, with every field in its own column. Download it as Excel whenever you want.

```
Guest scans QR / taps link ──► index.html (GitHub Pages) ──POST──► Apps Script web app ──► Google Sheet "Guests" tab
```

**Columns:** Submitted · First Name · Last Name · Street Address · Apt / Unit · City · State / Region · ZIP / Postal Code · Country · Phone · Email · Review

## Setup (about 10 minutes)

### 1. Google Sheet + Apps Script (the backend)

1. Create a new Google Sheet ([sheets.new](https://sheets.new)) and name it something like *Wedding Guest Addresses*.
2. **Extensions → Apps Script.** Delete the starter code, paste in all of `apps-script/Code.gs`, and click **Save**.
3. In the function dropdown at the top, choose **`setup`** and click **Run**. Approve the permissions prompt. Google will say the app is unverified because it's your own script: click **Advanced → Go to … (unsafe) → Allow**.
   - Setup creates the **Guests** tab, stores ZIP and phone as text so `07302` keeps its zero, adds duplicate highlighting, and creates a **Filtered** tab for spam.
4. **Deploy → New deployment →** gear icon **→ Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (not "Anyone with Google account")
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. Optional check: open that URL in a browser. You should see `{"ok":true,…}`.

### 2. Connect the page

Open `index.html`. Near the top is a block marked **EDIT ME**:

```js
window.WEDDING_CONFIG = {
  endpoint: 'https://script.google.com/macros/s/…/exec',  // ← paste the URL from step 1
  date: '',       // optional, e.g. 'June 12, 2027'
  location: '',   // optional, e.g. 'Hudson Valley, New York'
  contact: '',    // optional, shown if sending fails, e.g. 'text Kevin at (201) 555-0100'
  closed: false,
};
```

### 3. Publish + QR code

```bash
bash deploy.sh               # or: bash deploy.sh some-other-repo-name
```

This needs `git`, the GitHub CLI (`brew install gh && gh auth login`), and Node. It:

- creates a public repo named `wedding-address`
- turns on GitHub Pages
- sets the link-preview image URL
- writes `qr/address-qr.svg` (for print) and `qr/address-qr.png` (for texting)

It prints the live URL, which takes about a minute to come up. Re-run it any time you edit the page.

Manual route: create a public repo, push these files, then **Settings → Pages → Deploy from a branch → main / (root)**.

### 4. Test end to end (2 minutes, don't skip)

1. On your phone, open the URL and submit your own address.
2. In the **Guests** tab, confirm the ZIP reads `07302` (not `7302`) and every field is in its own column.
3. Delete the test row.
4. Text yourself the link to check the preview card.

## Using it

- **Excel:** In the Sheet, use **File → Download → Microsoft Excel (.xlsx)**. Use .xlsx, not CSV, because Excel strips the leading zero from ZIP codes when it opens a CSV.
- **Review column:** Flags possible duplicates (same address written differently, or same email) and anything that looks off (bad ZIP, short phone). Flagged rows are highlighted. Nothing is ever rejected, so you never lose a guest's submission.
- **Your own columns:** Add columns anywhere, such as *Save-the-date sent* or *Invited*. Don't rename the original headers: the script finds columns by name, and re-adds any that go missing.
- **Notifications:** **Tools → Notification settings → Edit notifications → Any changes are made**. Daily digest is the quiet option.
- **Closing the form:** Set `closed: true` in `WEDDING_CONFIG` and run `bash deploy.sh`. Guests then see a thank-you note instead of the form.
- **Wording:** The heading, intro, and thank-you text live in `index.html`. Link-preview text is in the `<meta property="og:…">` tags, and the preview image is `og-image.png`.
- **After editing `Code.gs`:** **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** The URL stays the same.

## Privacy

- The repo is public but contains no guest data. Guest data lives only in your Google Sheet.
- The web app only writes: `doGet` returns a status message and never data.
- The page is marked `noindex`, so search engines won't list it.
- Fonts are self-hosted (SIL OFL), so there are no Google Fonts or other third-party requests.
- A hidden honeypot field routes bot submissions to the **Filtered** tab.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Something went wrong" on submit | Deployment access must be **Anyone**, and `endpoint` must end in `/exec`. Check **Executions** in Apps Script for errors. |
| Edits to `Code.gs` aren't live | Deploy a **New version** (see above). |
| ZIP lost its leading zero | Re-run `setup` and check the log line "Text-safe write mode". Then use **Format → Number → Plain text** on that column and fix the cell. |
| No link preview in iMessage | Previews are cached. Test with `…/wedding-address/?v=2`. |

## Files

```
index.html             the page (design, form, validation, config)
apps-script/Code.gs    the backend: paste into Extensions → Apps Script
deploy.sh              publish to GitHub Pages + generate QR codes
og-image.png           link-preview card (1200×630)
apple-touch-icon.png   home-screen icon
favicon.svg            browser tab icon
fonts/                 Libre Caslon Display + Libre Caslon Text + Jost (SIL Open Font License)
```
