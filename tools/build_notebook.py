"""Convert percent-format .py into .ipynb and syntax-check each code cell."""
import ast, json, re, sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
parts = re.split(r"^# %%(.*)$", text, flags=re.M)
cells = []
for i in range(1, len(parts), 2):
    marker, body = parts[i], parts[i + 1].strip("\n")
    if "[markdown]" in marker:
        lines = [re.sub(r"^# ?", "", l) for l in body.splitlines()]
        cells.append({"cell_type": "markdown", "metadata": {}, "source": "\n".join(lines)})
    else:
        check = "\n".join("pass" if l.lstrip().startswith(("!", "%")) else l for l in body.splitlines())
        ast.parse(check)  # raises on syntax error
        cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": body})
for c in cells:
    lines = c["source"].splitlines(keepends=True)
    c["source"] = lines
nb = {"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "T4"},
      "kernelspec": {"name": "python3", "display_name": "Python 3"}, "language_info": {"name": "python"}},
      "nbformat": 4, "nbformat_minor": 5}
json.dump(nb, open(dst, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(f"OK: {len(cells)} cells -> {dst}")
