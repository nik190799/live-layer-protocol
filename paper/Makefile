# Build the paper: make        Clean: make clean
llp.pdf: llp.tex refs.bib
	pdflatex -interaction=nonstopmode -halt-on-error llp.tex
	bibtex llp
	pdflatex -interaction=nonstopmode -halt-on-error llp.tex
	pdflatex -interaction=nonstopmode -halt-on-error llp.tex

clean:
	rm -f llp.aux llp.bbl llp.blg llp.log llp.out
