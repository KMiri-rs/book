BIND ?= 127.0.0.1
PORT ?= 3001

.PHONY: check-mdbook check-mdbook-spec serve build clean

check-mdbook:
	@command -v mdbook > /dev/null 2>&1 || { echo "mdBook is not installed. Please install it first: cargo install mdbook"; exit 1; }
	@echo "mdBook is installed."

check-mdbook-spec:
	@command -v mdbook-spec > /dev/null 2>&1 || { echo "mdbook-spec is not installed. Please install it first: cargo install --git https://github.com/rust-lang/reference --locked mdbook-spec"; exit 1; }
	@echo "mdbook-spec is installed."

serve: check-mdbook check-mdbook-spec
	@mdbook serve --hostname $(BIND) --port $(PORT)

build: check-mdbook check-mdbook-spec
	@mdbook build

clean:
	@rm -rf public

install-mdbook:
	curl -sSL https://github.com/rust-lang/mdBook/releases/download/v0.5.4/mdbook-v0.5.4-x86_64-unknown-linux-gnu.tar.gz | tar xz \
		&& mv mdbook /usr/local/bin

install-rust:
	curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal

vercel-install-dev: install-mdbook install-rust
	export PATH="$$HOME/.cargo/bin:$$PATH" \
		&& cargo install --git https://github.com/rust-lang/reference --locked mdbook-spec
