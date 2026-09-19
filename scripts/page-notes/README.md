# Page Notes

Notes for the web page you are on, kept per page. A small pill sits in the
top-right corner: click it (or press **Alt+N**) and type. Come back to the page
later and the pill briefly shows the first line of what you wrote.

## Install

Open this URL with Tampermonkey installed and it offers to install:

    https://raw.githubusercontent.com/umershahzeb02/bumbletap/master/scripts/page-notes/page-notes.user.js

It carries `@updateURL`, so later changes arrive on their own, **provided
`@version` is bumped with each change**: Tampermonkey compares versions, not
content. To pull a change immediately: Tampermonkey dashboard → **Utilities** →
*Check for userscript updates*.

## Writing

Notes are blocks, as in Notion. Type `/` at the start of a block for the
format menu, or use the shortcut beside each one as you type:

| Type | Get |
|---|---|
| `# ` / `## ` | heading / subheading |
| `[] ` | a to-do; Ctrl/Cmd+Enter ticks it |
| `- ` / `1. ` | bulleted / numbered list |
| `> ` | a quote |
| `! ` | a highlight |
| ` ``` ` | a code block (Enter on an empty last line leaves it) |
| `---` | a divider |
| Enter | a new block (Shift+Enter for a line break inside one) |
| Backspace at the start of a block | turns it back into text, then joins it to the block above |
| Esc | closes the menu, then the panel; Alt+N toggles it from anywhere on the page |

Everything saves as you type. The bin in the header deletes the page's notes
and offers Undo instead of asking first. The panel stays open while you read and
scroll, and on the next page it opens (or stays shut) the way you left it.

Drag the pill anywhere. It settles against the nearer side edge and stays there
on every site. The Tampermonkey menu has **Show or hide the notes pill on this
site** and **Move the notes pill back to the top-right corner**.

Below this page's notes are the notes from every other page on the same site,
in full, newest first. Reading them doesn't leave the page you're on; the ↗
beside each page's title is what takes you there, and a to-do from another page
can be ticked right where it is shown. The section stays open unless you fold
it away.

## What counts as the same page

The URL, normalised so that one page does not end up with several sets of
notes:

- `www.` is ignored, and so is a trailing slash.
- Tracking parameters (`utm_*`, `fbclid`, `gclid`, `si` and similar) are
  dropped; the rest are sorted. The query is otherwise kept, because on many
  sites it *is* the page: a search, a product, a video.
- On `youtube.com/watch`, only `v` counts, so a timestamp or a playlist does not
  split one video's notes.
- The `#fragment` is ignored, unless it is a hash router's route (`#/inbox`).

Single-page apps are followed as they navigate (history events, plus a check
once a second), so the notes switch with the page.

## Staying out of the page

- **One element**, appended to `<html>`, holding a closed shadow root. No
  `<style>` is added to the document and no page element is restyled. The host is
  a 0×0 fixed box, so it takes no space in the layout.
- **The host's own style** is inline `all: initial !important`, which outranks
  any stylesheet rule, including one aimed at it by name.
- **Styles** are a constructed stylesheet adopted by the shadow root, so a strict
  `style-src` CSP does not block them. A `<style>` inside the shadow root is the
  fallback if adoption fails.
- **Keystrokes** typed into a note never reach the page, so site shortcuts
  (GitHub's `/`, YouTube's `k`) stay quiet. They are handled and stopped by a
  window capture listener installed at `document-start`, ahead of the page's own.
  Clicks in the panel are likewise hidden from the page's bubbling listeners.
- **Focus** is never taken on page load, even when the panel reopens by itself,
  so a page that puts the caret in its own search box keeps it there.

Tested end to end in Chrome over the DevTools protocol: on a deliberately hostile
page, every element computed the same styles and box with and without the
script, and none of the typing reached any of the page's listeners. On GitHub and
Wikipedia, the styles applied under their CSPs and `/` typed into the note
instead of opening their search.

## Storage

Tampermonkey's own storage (`GM_setValue`): private to the script, shared by
every site, and untouched when a site's data is cleared. Without the GM
functions (pasted into a console, say) it falls back to the site's localStorage:
it still works, but per site, and the site can read it.

## Known caveats

- Notes live in this browser's Tampermonkey storage. They do not sync to other
  browsers, and removing the script removes them.
- Fullscreen video and top-layer elements (modal `<dialog>`s, popovers) sit
  above the pill.
- `@noframes`: embedded frames never get a pill of their own.
