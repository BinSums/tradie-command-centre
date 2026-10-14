---
description: Put the business's own logo, colours and font on the dashboard. Reads them off their website, shows them before changing anything, then redeploys.
---

# Brand the dashboard

The person typing this wants the dashboard to look like their business and does not want to
design anything. Do the work, show them the result, and ask one yes/no question.

Same rules as setup: plain words, one question at a time, say what you are about to do.

## Step 1 of 4: find what is already there

```bash
cat ~/.command-centre/worker/brand.js
ls "${CLAUDE_PLUGIN_ROOT}/brands/"
```

If a pack in `brands/` matches their business, it was made for them before they installed.
Offer it first: "There is already a brand pack with your logo and colours in it. Use that?"
If yes, copy it over `~/.command-centre/worker/brand.js` and jump to step 4.

## Step 2 of 4: read their brand off their website

Ask for their website address if you do not have it. Then fetch the home page and its
stylesheets and work out:

- **accent**: the colour their buttons, links or header actually use most. Not black, not
  white, not a photo. If two colours compete, take the one on the logo.
- **accentOnDark**: a lighter tone of the same hue that still reads on near-black. Check it
  against `#0e1116`: if the contrast ratio is under 4.5, lighten it until it is not.
- **ink**: their body text colour, only if it is clearly not black or near-black grey.
- **font**: their heading or body font, only if it is on Google Fonts. Otherwise leave it out.
- **logo**: the logo file from the site header (an `<img>` in the header or `.logo`, or the
  `og:image` if it is clearly the logo). Prefer PNG or SVG. Download it, never hotlink.
  If it is white or very light, it is the dark-theme logo: put it in `logoOnDark` and look
  for the coloured one for `logo`.

If the site is down or they have none, ask them to drop the logo file into the chat and tell
you their main colour. That is enough.

## Step 3 of 4: show them before changing anything

Write the pack to `~/.command-centre/worker/brand.js` with a python heredoc, base64-encoding
the logo:

```js
export default {
  name: "Their Business Name",
  accent: "#2f6b3a",
  accentOnDark: "#7cc48a",
  font: "Montserrat",
  logo: { type: "image/png", b64: "..." },
};
```

Keep a copy of the old file first (`brand.js.bak-<date>`). Logos over 300 KB: resize to 512 px
wide with `sips -Z 512` (Mac) before encoding, since every page load carries the header.

Run the local preview so they can see it before it goes live:

```bash
cd ~/.command-centre/worker && npx wrangler dev --port 8799
```

Tell them to open <http://127.0.0.1:8799>, sign in with their usual password, and flick
through Light, Dark and Console at the top right. Ask: "Happy with that?" Stop the preview
after they answer.

## Step 4 of 4: put it live

```bash
cd ~/.command-centre/worker && npx wrangler deploy
```

Ask them to refresh their dashboard. Their answer is the test. If they want the colour
changed, change `accent` and deploy again; it takes thirty seconds.
