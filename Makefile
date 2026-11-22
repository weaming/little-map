BIN := bin/little-map
INSTALL_DIR := $(HOME)/go/bin

web/dist/index.html: $(shell find web/src web/public -type f 2>/dev/null) web/index.html web/package.json
	cd web && bun run build

$(BIN): web/dist/index.html $(shell find . -maxdepth 3 -name '*.go')
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o $(BIN) .

build: $(BIN)

install: $(BIN)
	mkdir -p $(INSTALL_DIR)
	install -m 755 $(BIN) $(INSTALL_DIR)/little-map

test:
	go test -v ./pkg/...
	cd web && bun test

clean:
	rm -rf bin web/dist
