BIND ?= 127.0.0.1
PORT ?= 3001

.PHONY: check-mdbook serve build clean

check-mdbook:
	@command -v mdbook > /dev/null 2>&1 || { echo "mdBook is not installed. Please install it first: cargo install mdbook"; exit 1; }
	@echo "mdBook is installed."

serve: check-mdbook
	@mdbook serve --hostname $(BIND) --port $(PORT)

build: check-mdbook
	@mdbook build

clean:
	@rm -rf public
