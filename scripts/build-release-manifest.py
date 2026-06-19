#!/usr/bin/env python3
"""Builds a version-pinned pack manifest: reads packs/<pack>/index.json and writes
dist/dalang_<pack>_pack.dapp with every codeUrl rewritten to an absolute raw URL
at <ref> (a tag/commit), so the scripts a release ships can never change.
updateUrl is left untouched (on main) so the in-app store can still update past
the pinned version. The output is the single file to upload to a data release.

Usage:
    python3 scripts/build-release-manifest.py <pack> <ref>
"""

import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

repo_root = Path(__file__).resolve().parent.parent


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: build-release-manifest.py <pack> <ref>")
    pack, ref = sys.argv[1], sys.argv[2]

    index_path = repo_root / "packs" / pack / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))

    update_url = index.get("updateUrl")
    if not isinstance(update_url, str) or not update_url.startswith("http"):
        raise SystemExit(
            f'Pack "{pack}" needs an absolute http(s) updateUrl to derive the raw base; got: {update_url}'
        )

    # Same owner/repo/path as updateUrl, with the branch segment swapped for <ref>.
    split = urlsplit(update_url)
    parts = split.path.split("/")  # ['', owner, repo, branch, *path, 'index.json']
    parts[3] = ref
    parts.pop()
    base = f"{split.scheme}://{split.netloc}{'/'.join(parts)}/"
    marker = f"/packs/{pack}/"

    for plugin in index.get("plugins", []):
        code_url = plugin.get("codeUrl")
        if not isinstance(code_url, str) or code_url.startswith("file:"):
            continue
        if code_url.startswith("http"):
            if marker not in code_url:
                continue  # absolute but not this repo — leave it
            code_url = code_url[code_url.index(marker) + len(marker):]
        plugin["codeUrl"] = base + code_url

    out_dir = repo_root / "dist"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"dalang_{pack}_pack.dapp"
    out_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Wrote {out_path} (pinned to {ref})")
    for plugin in index.get("plugins", []):
        print(f"  {plugin['id']} -> {plugin['codeUrl']}")


if __name__ == "__main__":
    main()
