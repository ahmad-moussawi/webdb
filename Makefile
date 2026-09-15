CMAKE ?= cmake
EMCMAKE ?= emcmake

NATIVE_BUILD_DIR ?= dist/native
WASM_BUILD_DIR ?= dist/wasm

.PHONY: all help configure build test run wasm wasm-prod clean

all: build

help:
	@printf '%s\n' \
		'WebDB build commands:' \
		'  make build      Configure and build the native targets' \
		'  make test       Build and run all native CTest tests' \
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

run: build
	$(NATIVE_BUILD_DIR)/webdb_cli

wasm:
	$(EMCMAKE) $(CMAKE) -S . -B $(WASM_BUILD_DIR)
	$(CMAKE) --build $(WASM_BUILD_DIR)

wasm-prod:
	$(EMCMAKE) $(CMAKE) -S . -B $(WASM_BUILD_DIR) -DWEBDB_WASM_SIZE_OPTIMIZED=ON
	$(CMAKE) --build $(WASM_BUILD_DIR)

clean:
	$(CMAKE) -E rm -rf $(NATIVE_BUILD_DIR) $(WASM_BUILD_DIR)