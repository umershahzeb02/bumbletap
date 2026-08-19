# Copy Pill

A **Copy** button appears beside any text you select, on any page. When the
selection contains a link, an **Open** button appears next to it.

## Install

Open this URL with Tampermonkey installed and it offers to install:

    https://raw.githubusercontent.com/umershahzeb02/bumbletap/master/scripts/copy-pill/copy-pill.user.js

It carries `@updateURL`, so later changes arrive on their own. To pull one
immediately: Tampermonkey dashboard → **Utilities** → *Check for userscript
updates*.

## Link detection

Two independent sources, DOM first:

1. **Real hyperlinks** — read out of the selection's nodes. This is the case
   that matters on Wikipedia, where the visible text is "Alan Turing" and the
   destination only exists as an `href`.
2. **URLs written out in the text** — matched against a fixed TLD list, so
   `Node.js`, `notes.txt` and `array.map(fn)` are not mistaken for links.

When both are present the `href` wins: link text is free to disagree with where
the link actually goes, and the true destination is the safer thing to show.

Deliberately ignored: same-page `#fragment` jumps (a footnote is not a
destination), and `javascript:` / `mailto:` / `tel:` hrefs.

## Known caveats

- The `addEventListener` patch that unblocks copy-hostile pages is global. It
  also refuses `dragstart`, which breaks drag-and-drop interfaces, and `copy` /
  `cut`, which rich text editors rely on. It should be made conditional on
  actually detecting a block.
- Inside an iframe the pill is built in that frame, so it is clipped to the
  frame's bounds.
- Text in a shadow root may not reach `document.getSelection()`, so no pill
  appears there.
