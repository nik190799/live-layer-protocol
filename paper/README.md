# LLP research paper

`llp.tex` is an arXiv-style systems paper on the Live Layer Protocol; `llp.pdf` is the built copy.

## Build

```sh
cd paper && make        # pdflatex + bibtex; needs TeX Live with pgfplots, booktabs, listings, xspace
make clean              # remove the intermediate files
```

On Debian or Ubuntu: `apt-get install texlive-latex-recommended texlive-latex-extra texlive-pictures texlive-fonts-recommended lmodern`.

## Where the numbers come from

Every number in the paper was produced by a script in this repo and re-run on 2026-11-17 on one
4-vCPU cloud VM. The raw output is in `results/`:

| File | Command | Used in |
|---|---|---|
| `results/benchmark.json` | `npm run bench` | Tables 2 and 3, Figure 2, rollback figures |
| `results/hosts.json` | `npm run bench:hosts` | Table 5 |
| `results/case-studies.json` | `npm run case-studies` | Table 6 |
| `results/demo-github-ci.json` | `node tools/demo-gif/record.mjs` (the recorded launch run, a copy of `docs/demo-run.json`) | Table 4, hosted CI column |
| `results/demo-local-ci.json` | `node tools/demo-gif/record.mjs --ci local` | Table 4, local CI column |

Test counts come from `npm test` (428 checks), `npm run test:go` (161 vectors and 14 interop checks),
`node test/browser.mjs` (8) and `npm run redteam` (0 of 6 findings still hold).

The author line is set by `\paperauthor` and `\paperaffil` near the top of `llp.tex`.
