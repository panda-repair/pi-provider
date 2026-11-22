"""Compare all regular files in two npm tarballs without extracting either archive."""
import hashlib
import sys
import tarfile


def files(path):
    result = {}
    seen = set()
    with tarfile.open(path, "r:gz") as archive:
        for entry in archive:
            name = entry.name.removesuffix("/")
            if (not name.isprintable() or "\\" in name or any(part in ("", ".", "..") for part in name.split("/"))
                    or name in seen):
                raise ValueError(f"Unsafe or duplicate member in {path}: {name!r}")
            seen.add(name)
            if entry.isdir():
                continue
            if not entry.isfile():
                raise ValueError(f"Expected a regular file in {path}: {name!r}")
            with archive.extractfile(entry) as content:
                digest = hashlib.sha256()
                for chunk in iter(lambda: content.read(1024 * 1024), b""):
                    digest.update(chunk)
                result[name] = digest.hexdigest()
    if not result:
        raise ValueError(f"Empty package: {path}")
    return result


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: python3 compare-package.py CI-PACKAGE LOCAL-PACKAGE")
    canonical, local = (files(path) for path in sys.argv[1:])
    differences = sorted(name for name in canonical.keys() | local.keys() if canonical.get(name) != local.get(name))
    if differences:
        sys.exit("Missing, extra or changed files: " + ", ".join(differences))
    for name in sorted(canonical):
        print(canonical[name], name, sep="  ")
