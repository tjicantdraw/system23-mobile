# system24 mobile

A system24-style mod for Discord mobile (Kettu, Bunny or Revenge). It has two parts:

- **`theme.json`**: system24's color palette.
- **`plugin/`**: monospace font everywhere, boxy panels with square corners and thin borders, and hiding for Quests, Nitro and Shop.

## 1. Put it on GitHub (once)

Kettu installs plugins and themes from links, so the files need to be online.

1. On github.com, click **+ → New repository**, name it `system24-mobile`, and set it to **Public**. It must be public, or Kettu can't download it.
2. Click **uploading an existing file**, drag in `README.md`, `theme.json` and the whole `plugin` folder, then click **Commit changes**.
3. Your links will be (replace `YOURNAME` with your GitHub username):
   - Plugin: `https://raw.githubusercontent.com/YOURNAME/system24-mobile/main/plugin/`
     - Keep the `/` at the end. It points at the folder.
   - Theme: `https://raw.githubusercontent.com/YOURNAME/system24-mobile/main/theme.json`

## 2. Install on your phone

1. **Theme:** go to Discord **Settings → Kettu → Themes → +**, paste the theme link, and turn it on.
2. **Plugin:** go to **Settings → Kettu → Plugins → +**, paste the plugin link, and turn it on.
3. **Fully close Discord and reopen it.** Boxy panels only apply after a restart.

The plugin's gear icon has the settings: font, letter spacing, each hide toggle, and a **Debug** section.

## 3. Sending feedback

Use Discord for a few minutes, including the home screen, DMs, a server and your profile. Then:

1. Open the plugin settings and tap **Copy debug report**.
2. Paste that report, plus screenshots of anything that looks wrong or any Quest or Nitro element that's still showing.

The report lists what got hidden and what looked related but wasn't, which is how the next version gets fixed.

## Updating

When you get a new version, replace the files on GitHub. Kettu notices the change and updates the plugin, or you can toggle the plugin off and on.

## If something breaks

- **Discord crashes on launch:** open Kettu's recovery or safe mode by holding the volume button during launch or using KettuManager's options, then disable the plugin.
- **Text gets cut off:** monospace text is wider. Lower the letter spacing in the plugin settings, or turn off **Monospace font**.
- **DM Mono font:** if your Kettu has a **Fonts** section, install DM Mono there, then set the plugin's **Font family** to `DM Mono`.
