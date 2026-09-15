CMAKE ?= cmake
EMCMAKE ?= emcmake

NATIVE_BUILD_DIR ?= dist/native
WASM_BUILD_DIR ?= dist/wasm

.PHONY: all help configure build test web-test web-browser-test format run wasm wasm-prod clean

all: build

help:
	@printf '%s\n' \
		'WebDB build commands:' \
		'  make build      Configure and build the native targets' \
		'  make test       Build and run all native CTest tests' \
		'  make web-test   Type-check and test the TypeScript worker host' \
		'  make web-browser-test  Run real-browser IndexedDB integration tests' \
		'  make format     Format tracked C++ source and header files' \
		'  make run        Build and run the native CLI' \
		'  make wasm       Configure and build the development WASM target' \
		'  make wasm-prod  Configure and build the size-optimized WASM target' \
		'  make clean      Remove native and WASM build directories'

configure:
	$(CMAKE) -S . -B $(NATIVE_BUILD_DIR)

build: configure
	$(CMAKE) --build $(NATIVE_BUILD_DIR)

test: build
	ctest --test-dir $(NATIVE_BUILD_DIR) --output-on-failure

web-test: wasm
	@npm --prefix web run check
	@npm --prefix web test

web-browser-test:
	@npm --prefix web run test:browser

format:
	@command -v clang-format >/dev/null || { echo 'clang-format is required; install it with: brew install clang-format'; exit 1; }
	@git ls-files '*.cpp' '*.hpp' | xargs clang-format -i

run: build
	$(NATIVE_BUILD_DIR)/webdb_cli

wasm:
	$(EMCMAKE) $(CMAKE) -S . -B $(WASM_BUILD_DIR) -DWEBDB_WASM_SIZE_OPTIMIZED=OFF
	$(CMAKE) --build $(WASM_BUILD_DIR)

wasm-prod:
	$(EMCMAKE) $(CMAKE) -S . -B $(WASM_BUILD_DIR) -DWEBDB_WASM_SIZE_OPTIMIZED=ON
	$(CMAKE) --build $(WASM_BUILD_DIR)

clean:
	$(CMAKE) -E rm -rf $(NATIVE_BUILD_DIR) $(WASM_BUILD_DIR)