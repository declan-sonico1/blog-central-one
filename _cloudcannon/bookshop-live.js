// Copyright 2018 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

(() => {
	// Map multiple JavaScript environments to a single common API,
	// preferring web standards over Node.js API.
	//
	// Environments considered:
	// - Browsers
	// - Node.js
	// - Electron
	// - Parcel
	// - Webpack

	if (typeof global !== "undefined") {
		// global already exists
	} else if (typeof window !== "undefined") {
		window.global = window;
	} else if (typeof self !== "undefined") {
		self.global = self;
	} else {
		throw new Error("cannot export Go (neither global, window nor self is defined)");
	}

	if (!global.require && typeof require !== "undefined") {
		global.require = require;
	}

	if (!global.fs && global.require) {
		const fs = require("fs");
		if (typeof fs === "object" && fs !== null && Object.keys(fs).length !== 0) {
			global.fs = fs;
		}
	}

	const enosys = () => {
		const err = new Error("not implemented");
		err.code = "ENOSYS";
		return err;
	};

	if (!global.fs) {
		let outputBuf = "";
		global.fs = {
			constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 }, // unused
			writeSync(fd, buf) {
				outputBuf += decoder.decode(buf);
				const nl = outputBuf.lastIndexOf("\n");
				if (nl != -1) {
					// Track logs for Bookshop to pick up later
					window.hugo_wasm_logging = window.hugo_wasm_logging || [];
					window.hugo_wasm_logging.push(outputBuf.substr(0, nl));

					// Disable console logs from the WASM side
					if (window.log_hugo_wasm) {
						console.log(outputBuf.substr(0, nl));
					}
					outputBuf = outputBuf.substr(nl + 1);
				}
				return buf.length;
			},
			write(fd, buf, offset, length, position, callback) {
				if (offset !== 0 || length !== buf.length || position !== null) {
					callback(enosys());
					return;
				}
				const n = this.writeSync(fd, buf);
				callback(null, n);
			},
			chmod(path, mode, callback) { callback(enosys()); },
			chown(path, uid, gid, callback) { callback(enosys()); },
			close(fd, callback) { callback(enosys()); },
			fchmod(fd, mode, callback) { callback(enosys()); },
			fchown(fd, uid, gid, callback) { callback(enosys()); },
			fstat(fd, callback) { callback(enosys()); },
			fsync(fd, callback) { callback(null); },
			ftruncate(fd, length, callback) { callback(enosys()); },
			lchown(path, uid, gid, callback) { callback(enosys()); },
			link(path, link, callback) { callback(enosys()); },
			lstat(path, callback) { callback(enosys()); },
			mkdir(path, perm, callback) { callback(enosys()); },
			open(path, flags, mode, callback) { callback(enosys()); },
			read(fd, buffer, offset, length, position, callback) { callback(enosys()); },
			readdir(path, callback) { callback(enosys()); },
			readlink(path, callback) { callback(enosys()); },
			rename(from, to, callback) { callback(enosys()); },
			rmdir(path, callback) { callback(enosys()); },
			stat(path, callback) { callback(enosys()); },
			symlink(path, link, callback) { callback(enosys()); },
			truncate(path, length, callback) { callback(enosys()); },
			unlink(path, callback) { callback(enosys()); },
			utimes(path, atime, mtime, callback) { callback(enosys()); },
		};
	}

	if (!global.process) {
		global.process = {
			getuid() { return -1; },
			getgid() { return -1; },
			geteuid() { return -1; },
			getegid() { return -1; },
			getgroups() { throw enosys(); },
			pid: -1,
			ppid: -1,
			umask() { throw enosys(); },
			cwd() { throw enosys(); },
			chdir() { throw enosys(); },
		}
	}

	if (!global.crypto && global.require) {
		const nodeCrypto = require("crypto");
		global.crypto = {
			getRandomValues(b) {
				nodeCrypto.randomFillSync(b);
			},
		};
	}
	if (!global.crypto) {
		throw new Error("global.crypto is not available, polyfill required (getRandomValues only)");
	}

	if (!global.performance) {
		global.performance = {
			now() {
				const [sec, nsec] = process.hrtime();
				return sec * 1000 + nsec / 1000000;
			},
		};
	}

	if (!global.TextEncoder && global.require) {
		global.TextEncoder = require("util").TextEncoder;
	}
	if (!global.TextEncoder) {
		throw new Error("global.TextEncoder is not available, polyfill required");
	}

	if (!global.TextDecoder && global.require) {
		global.TextDecoder = require("util").TextDecoder;
	}
	if (!global.TextDecoder) {
		throw new Error("global.TextDecoder is not available, polyfill required");
	}

	// End of polyfills for common API.

	const encoder = new TextEncoder("utf-8");
	const decoder = new TextDecoder("utf-8");

	global.Go = class {
		constructor() {
			this.argv = ["js"];
			this.env = {};
			this.exit = (code) => {
				if (code !== 0) {
					console.warn("exit code:", code);
				}
			};
			this._exitPromise = new Promise((resolve) => {
				this._resolveExitPromise = resolve;
			});
			this._pendingEvent = null;
			this._scheduledTimeouts = new Map();
			this._nextCallbackTimeoutID = 1;

			const setInt64 = (addr, v) => {
				this.mem.setUint32(addr + 0, v, true);
				this.mem.setUint32(addr + 4, Math.floor(v / 4294967296), true);
			}

			const getInt64 = (addr) => {
				const low = this.mem.getUint32(addr + 0, true);
				const high = this.mem.getInt32(addr + 4, true);
				return low + high * 4294967296;
			}

			const loadValue = (addr) => {
				const f = this.mem.getFloat64(addr, true);
				if (f === 0) {
					return undefined;
				}
				if (!isNaN(f)) {
					return f;
				}

				const id = this.mem.getUint32(addr, true);
				return this._values[id];
			}

			const storeValue = (addr, v) => {
				const nanHead = 0x7FF80000;

				if (typeof v === "number" && v !== 0) {
					if (isNaN(v)) {
						this.mem.setUint32(addr + 4, nanHead, true);
						this.mem.setUint32(addr, 0, true);
						return;
					}
					this.mem.setFloat64(addr, v, true);
					return;
				}

				if (v === undefined) {
					this.mem.setFloat64(addr, 0, true);
					return;
				}

				let id = this._ids.get(v);
				if (id === undefined) {
					id = this._idPool.pop();
					if (id === undefined) {
						id = this._values.length;
					}
					this._values[id] = v;
					this._goRefCounts[id] = 0;
					this._ids.set(v, id);
				}
				this._goRefCounts[id]++;
				let typeFlag = 0;
				switch (typeof v) {
					case "object":
						if (v !== null) {
							typeFlag = 1;
						}
						break;
					case "string":
						typeFlag = 2;
						break;
					case "symbol":
						typeFlag = 3;
						break;
					case "function":
						typeFlag = 4;
						break;
				}
				this.mem.setUint32(addr + 4, nanHead | typeFlag, true);
				this.mem.setUint32(addr, id, true);
			}

			const loadSlice = (addr) => {
				const array = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				return new Uint8Array(this._inst.exports.mem.buffer, array, len);
			}

			const loadSliceOfValues = (addr) => {
				const array = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				const a = new Array(len);
				for (let i = 0; i < len; i++) {
					a[i] = loadValue(array + i * 8);
				}
				return a;
			}

			const loadString = (addr) => {
				const saddr = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				return decoder.decode(new DataView(this._inst.exports.mem.buffer, saddr, len));
			}

			const timeOrigin = Date.now() - performance.now();
			this.importObject = {
				go: {
					// Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
					// may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
					// function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
					// This changes the SP, thus we have to update the SP used by the imported function.

					// func wasmExit(code int32)
					"runtime.wasmExit": (sp) => {
						sp >>>= 0;
						const code = this.mem.getInt32(sp + 8, true);
						this.exited = true;
						delete this._inst;
						delete this._values;
						delete this._goRefCounts;
						delete this._ids;
						delete this._idPool;
						this.exit(code);
					},

					// func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
					"runtime.wasmWrite": (sp) => {
						sp >>>= 0;
						const fd = getInt64(sp + 8);
						const p = getInt64(sp + 16);
						const n = this.mem.getInt32(sp + 24, true);
						fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));
					},

					// func resetMemoryDataView()
					"runtime.resetMemoryDataView": (sp) => {
						sp >>>= 0;
						this.mem = new DataView(this._inst.exports.mem.buffer);
					},

					// func nanotime1() int64
					"runtime.nanotime1": (sp) => {
						sp >>>= 0;
						setInt64(sp + 8, (timeOrigin + performance.now()) * 1000000);
					},

					// func walltime() (sec int64, nsec int32)
					"runtime.walltime": (sp) => {
						sp >>>= 0;
						const msec = (new Date).getTime();
						setInt64(sp + 8, msec / 1000);
						this.mem.setInt32(sp + 16, (msec % 1000) * 1000000, true);
					},

					// func scheduleTimeoutEvent(delay int64) int32
					"runtime.scheduleTimeoutEvent": (sp) => {
						sp >>>= 0;
						const id = this._nextCallbackTimeoutID;
						this._nextCallbackTimeoutID++;
						this._scheduledTimeouts.set(id, setTimeout(
							() => {
								this._resume();
								while (this._scheduledTimeouts.has(id)) {
									// for some reason Go failed to register the timeout event, log and try again
									// (temporary workaround for https://github.com/golang/go/issues/28975)
									console.warn("scheduleTimeoutEvent: missed timeout event");
									this._resume();
								}
							},
							getInt64(sp + 8) + 1, // setTimeout has been seen to fire up to 1 millisecond early
						));
						this.mem.setInt32(sp + 16, id, true);
					},

					// func clearTimeoutEvent(id int32)
					"runtime.clearTimeoutEvent": (sp) => {
						sp >>>= 0;
						const id = this.mem.getInt32(sp + 8, true);
						clearTimeout(this._scheduledTimeouts.get(id));
						this._scheduledTimeouts.delete(id);
					},

					// func getRandomData(r []byte)
					"runtime.getRandomData": (sp) => {
						sp >>>= 0;
						crypto.getRandomValues(loadSlice(sp + 8));
					},

					// func finalizeRef(v ref)
					"syscall/js.finalizeRef": (sp) => {
						sp >>>= 0;
						const id = this.mem.getUint32(sp + 8, true);
						this._goRefCounts[id]--;
						if (this._goRefCounts[id] === 0) {
							const v = this._values[id];
							this._values[id] = null;
							this._ids.delete(v);
							this._idPool.push(id);
						}
					},

					// func stringVal(value string) ref
					"syscall/js.stringVal": (sp) => {
						sp >>>= 0;
						storeValue(sp + 24, loadString(sp + 8));
					},

					// func valueGet(v ref, p string) ref
					"syscall/js.valueGet": (sp) => {
						sp >>>= 0;
						const result = Reflect.get(loadValue(sp + 8), loadString(sp + 16));
						sp = this._inst.exports.getsp() >>> 0; // see comment above
						storeValue(sp + 32, result);
					},

					// func valueSet(v ref, p string, x ref)
					"syscall/js.valueSet": (sp) => {
						sp >>>= 0;
						Reflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32));
					},

					// func valueDelete(v ref, p string)
					"syscall/js.valueDelete": (sp) => {
						sp >>>= 0;
						Reflect.deleteProperty(loadValue(sp + 8), loadString(sp + 16));
					},

					// func valueIndex(v ref, i int) ref
					"syscall/js.valueIndex": (sp) => {
						sp >>>= 0;
						storeValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)));
					},

					// valueSetIndex(v ref, i int, x ref)
					"syscall/js.valueSetIndex": (sp) => {
						sp >>>= 0;
						Reflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24));
					},

					// func valueCall(v ref, m string, args []ref) (ref, bool)
					"syscall/js.valueCall": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const m = Reflect.get(v, loadString(sp + 16));
							const args = loadSliceOfValues(sp + 32);
							const result = Reflect.apply(m, v, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 56, result);
							this.mem.setUint8(sp + 64, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 56, err);
							this.mem.setUint8(sp + 64, 0);
						}
					},

					// func valueInvoke(v ref, args []ref) (ref, bool)
					"syscall/js.valueInvoke": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const args = loadSliceOfValues(sp + 16);
							const result = Reflect.apply(v, undefined, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, result);
							this.mem.setUint8(sp + 48, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, err);
							this.mem.setUint8(sp + 48, 0);
						}
					},

					// func valueNew(v ref, args []ref) (ref, bool)
					"syscall/js.valueNew": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const args = loadSliceOfValues(sp + 16);
							const result = Reflect.construct(v, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, result);
							this.mem.setUint8(sp + 48, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, err);
							this.mem.setUint8(sp + 48, 0);
						}
					},

					// func valueLength(v ref) int
					"syscall/js.valueLength": (sp) => {
						sp >>>= 0;
						setInt64(sp + 16, parseInt(loadValue(sp + 8).length));
					},

					// valuePrepareString(v ref) (ref, int)
					"syscall/js.valuePrepareString": (sp) => {
						sp >>>= 0;
						const str = encoder.encode(String(loadValue(sp + 8)));
						storeValue(sp + 16, str);
						setInt64(sp + 24, str.length);
					},

					// valueLoadString(v ref, b []byte)
					"syscall/js.valueLoadString": (sp) => {
						sp >>>= 0;
						const str = loadValue(sp + 8);
						loadSlice(sp + 16).set(str);
					},

					// func valueInstanceOf(v ref, t ref) bool
					"syscall/js.valueInstanceOf": (sp) => {
						sp >>>= 0;
						this.mem.setUint8(sp + 24, (loadValue(sp + 8) instanceof loadValue(sp + 16)) ? 1 : 0);
					},

					// func copyBytesToGo(dst []byte, src ref) (int, bool)
					"syscall/js.copyBytesToGo": (sp) => {
						sp >>>= 0;
						const dst = loadSlice(sp + 8);
						const src = loadValue(sp + 32);
						if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
							this.mem.setUint8(sp + 48, 0);
							return;
						}
						const toCopy = src.subarray(0, dst.length);
						dst.set(toCopy);
						setInt64(sp + 40, toCopy.length);
						this.mem.setUint8(sp + 48, 1);
					},

					// func copyBytesToJS(dst ref, src []byte) (int, bool)
					"syscall/js.copyBytesToJS": (sp) => {
						sp >>>= 0;
						const dst = loadValue(sp + 8);
						const src = loadSlice(sp + 16);
						if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
							this.mem.setUint8(sp + 48, 0);
							return;
						}
						const toCopy = src.subarray(0, dst.length);
						dst.set(toCopy);
						setInt64(sp + 40, toCopy.length);
						this.mem.setUint8(sp + 48, 1);
					},

					"debug": (value) => {
						// Disable all logs from the WASM side
						// console.log(value);	
					},
				}
			};
		}

		async run(instance) {
			if (!(instance instanceof WebAssembly.Instance)) {
				throw new Error("Go.run: WebAssembly.Instance expected");
			}
			this._inst = instance;
			this.mem = new DataView(this._inst.exports.mem.buffer);
			this._values = [ // JS values that Go currently has references to, indexed by reference id
				NaN,
				0,
				null,
				true,
				false,
				global,
				this,
			];
			this._goRefCounts = new Array(this._values.length).fill(Infinity); // number of references that Go has to a JS value, indexed by reference id
			this._ids = new Map([ // mapping from JS values to reference ids
				[0, 1],
				[null, 2],
				[true, 3],
				[false, 4],
				[global, 5],
				[this, 6],
			]);
			this._idPool = [];   // unused ids that have been garbage collected
			this.exited = false; // whether the Go program has exited

			// Pass command line arguments and environment variables to WebAssembly by writing them to the linear memory.
			let offset = 4096;

			const strPtr = (str) => {
				const ptr = offset;
				const bytes = encoder.encode(str + "\0");
				new Uint8Array(this.mem.buffer, offset, bytes.length).set(bytes);
				offset += bytes.length;
				if (offset % 8 !== 0) {
					offset += 8 - (offset % 8);
				}
				return ptr;
			};

			const argc = this.argv.length;

			const argvPtrs = [];
			this.argv.forEach((arg) => {
				argvPtrs.push(strPtr(arg));
			});
			argvPtrs.push(0);

			const keys = Object.keys(this.env).sort();
			keys.forEach((key) => {
				argvPtrs.push(strPtr(`${key}=${this.env[key]}`));
			});
			argvPtrs.push(0);

			const argv = offset;
			argvPtrs.forEach((ptr) => {
				this.mem.setUint32(offset, ptr, true);
				this.mem.setUint32(offset + 4, 0, true);
				offset += 8;
			});

			// The linker guarantees global data starts from at least wasmMinDataAddr.
			// Keep in sync with cmd/link/internal/ld/data.go:wasmMinDataAddr.
			const wasmMinDataAddr = 4096 + 4096;
			if (offset >= wasmMinDataAddr) {
				throw new Error("command line too long");
			}

			this._inst.exports.run(argc, argv);
			if (this.exited) {
				this._resolveExitPromise();
			}
			await this._exitPromise;
		}

		_resume() {
			if (this.exited) {
				throw new Error("Go program has already exited");
			}
			this._inst.exports.resume();
			if (this.exited) {
				this._resolveExitPromise();
			}
		}

		_makeFuncWrapper(id) {
			const go = this;
			return function () {
				const event = { id: id, this: this, args: arguments };
				go._pendingEvent = event;
				go._resume();
				return event.result;
			};
		}
	}

	if (
		typeof module !== "undefined" &&
		global.require &&
		global.require.main === module &&
		global.process &&
		global.process.versions &&
		!global.process.versions.electron
	) {
		if (process.argv.length < 3) {
			console.error("usage: go_js_wasm_exec [wasm binary] [arguments]");
			process.exit(1);
		}

		const go = new Go();
		go.argv = process.argv.slice(2);
		go.env = Object.assign({ TMPDIR: require("os").tmpdir() }, process.env);
		go.exit = process.exit;
		WebAssembly.instantiate(fs.readFileSync(process.argv[2]), go.importObject).then((result) => {
			process.on("exit", (code) => { // Node.js exits if no event handler is pending
				if (code === 0 && !go.exited) {
					// deadlock, make Go print error and stack traces
					go._pendingEvent = { id: 0 };
					go._resume();
				}
			});
			return go.run(result.instance);
		}).catch((err) => {
			console.error(err);
			process.exit(1);
		});
	}
})();

(() => {
  var __defProp = Object.defineProperty;
  var __markAsModule = (target) => __defProp(target, "__esModule", { value: true });
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[Object.keys(fn)[0]])(fn = 0)), res;
  };
  var __export = (target, all) => {
    __markAsModule(target);
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop.html
  var bookshop_exports = {};
  __export(bookshop_exports, {
    default: () => bookshop_default
  });
  var bookshop_default;
  var init_bookshop = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop.html"() {
      bookshop_default = '{{/*\n    Renders a Bookshop component\n\n    Expects a slice:\n    [\n        <string>, # Component name\n        <_>       # Component props\n    ]\n\n    Or a struct:\n    {\n        _bookshop_name: <string>, # Component name\n        ...,                      # Component props\n    }\n\n    Or a <string>: # Component name\n*/}}\n\n{{- $component_name := false -}}\n{{- $component_props := false -}}\n\n{{- if reflect.IsSlice . -}}\n    {{- if eq (len .) 2 -}}\n        {{- if eq (printf "%T" (index . 0)) "string" -}}\n            {{- $component_name = index . 0 -}}\n            {{- $component_props = index . 1 -}}\n        {{- else -}}\n            {{- $err := printf "Expected the first argument to be a string of the component name. Received %+v" (index . 0) -}}\n            {{- partial "_bookshop/errors/bad_bookshop_tag" $err -}}\n        {{- end -}}\n    {{- else -}}\n        {{- $err := printf "Expected a slice of length 2, was given %d" (len .) -}}\n        {{- partial "_bookshop/errors/bad_bookshop_tag" $err -}}\n    {{- end -}}\n{{- else if reflect.IsMap . -}}\n    {{- if isset . "_bookshop_name" -}}\n        {{- $component_name = ._bookshop_name -}}\n        {{- $component_props = . -}}\n    {{- else -}}\n        {{- $err := printf "Expected the provided map to contain a _bookshop_name key. Was given %+v" . -}}\n        {{- partial "_bookshop/errors/bad_bookshop_tag" $err -}}\n    {{- end -}}\n{{- else if eq (printf "%T" .) "string" -}}\n    {{- $component_name = . -}}\n    {{- $component_props = true -}}\n{{- else if . -}}\n    {{- $err := printf "Expected a map, slice, or string. Was given the %T: %+v" . . -}}\n    {{- partial "_bookshop/errors/bad_bookshop_tag" $err -}}\n{{- else -}}\n    {{- $err := printf "Expected a map, slice, or string. Was provided with no arguments" -}}\n    {{- partial "_bookshop/errors/bad_bookshop_tag" $err -}}\n{{- end -}}\n\n{{- if and $component_name $component_props -}}\n    {{- partial "_bookshop/helpers/component" (slice $component_name $component_props) -}}\n{{- end -}}';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop_scss.html
  var bookshop_scss_exports = {};
  __export(bookshop_scss_exports, {
    default: () => bookshop_scss_default
  });
  var bookshop_scss_default;
  var init_bookshop_scss = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop_scss.html"() {
      bookshop_scss_default = '{{/*\n    Returns a slice of all Bookshop SCSS resources\n*/}}\n\n{{ $components := resources.Match "bookshop/components/**.scss" }}\n{{ $shared := resources.Match "bookshop/shared/styles/**.scss" }}\n{{ $bookshop_scss := $shared | append $components }}\n\n{{ return $bookshop_scss }}\n';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop_partial.html
  var bookshop_partial_exports = {};
  __export(bookshop_partial_exports, {
    default: () => bookshop_partial_default
  });
  var bookshop_partial_default;
  var init_bookshop_partial = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop_partial.html"() {
      bookshop_partial_default = '{{/*\n    Renders a Bookshop partial\n\n    Expects a slice:\n    [\n        <string>, # Partial name\n        <_>       # Partial props\n    ]\n\n    Or a <string>: # Component name\n*/}}\n\n{{- $partial_name := false -}}\n{{- $partial_props := false -}}\n\n{{- if reflect.IsSlice . -}}\n    {{- if eq (len .) 2 -}}\n        {{- if eq (printf "%T" (index . 0)) "string" -}}\n            {{- $partial_name = index . 0 -}}\n            {{- $partial_props = index . 1 -}}\n        {{- else -}}\n            {{- $err := printf "Expected the first argument to be a string of the partial name. Received %+v" (index . 0) -}}\n            {{- partial "_bookshop/errors/bad_bookshop_tag" $err -}}\n        {{- end -}}\n    {{- else -}}\n        {{- $err := printf "Expected a slice of length 2, was given %d" (len .) -}}\n        {{- partial "_bookshop/errors/bad_bookshop_tag" $err -}}\n    {{- end -}}\n{{- else if eq (printf "%T" .) "string" -}}\n    {{- $partial_name = . -}}\n    {{- $partial_props = true -}}\n{{- else if . -}}\n    {{- $err := printf "bookshop_partial tag expected a slice or string. Was given the %T: %+v" . . -}}\n    {{- partial "_bookshop/errors/bad_bookshop_tag" $err -}}\n{{- else -}}\n    {{- $err := printf "bookshop_partial tag expected a slice or string. Was provided with no arguments" -}}\n    {{- partial "_bookshop/errors/bad_bookshop_tag" $err -}}\n{{- end -}}\n\n{{- if and $partial_name $partial_props -}}\n    {{- partial "_bookshop/helpers/partial" (slice $partial_name $partial_props) -}}\n{{- end -}}';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop_component_browser.html
  var bookshop_component_browser_exports = {};
  __export(bookshop_component_browser_exports, {
    default: () => bookshop_component_browser_default
  });
  var bookshop_component_browser_default;
  var init_bookshop_component_browser = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop_component_browser.html"() {
      bookshop_component_browser_default = '{{/*\n    Scaffolds the local or hosted Bookshop component browser\n*/}}\n\n{{- $port := 30775 -}}\n{{- if . -}}\n    {{- if eq "int" (printf "%T" .) -}}\n        {{- $port = . -}}\n    {{- else -}}\n        {{- $err := slice \n            "bookshop_component_browser expected either no argument, or an integer for the local port number used when running @bookshop/browser."\n            (printf "     Received: \\"%s\\"" .)\n            "     "\n            "     Example usage:"\n            " \u250C\u2500"\n            " \u2502    {{ partial \\"bookshop_component_browser\\" }}"\n            " \u251C\u2500"\n            " \u2502    {{ partial \\"bookshop_component_browser\\" 30775 }}"\n            " \u2514\u2500"\n        -}}\n        {{- partial "_bookshop/errors/err" (delimit $err "\\n") -}}\n    {{- end -}}\n{{ end }}\n\n<div data-bookshop-browser=""></div>\n<script src="http://localhost:{{ $port }}/bookshop.js"><\/script>\n<script>\n    window.bookshopBrowser = new window.BookshopBrowser({globals: []});\n    window.bookshopBrowser.render();\n<\/script>';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop_bindings.html
  var bookshop_bindings_exports = {};
  __export(bookshop_bindings_exports, {
    default: () => bookshop_bindings_default
  });
  var bookshop_bindings_default;
  var init_bookshop_bindings = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/bookshop_bindings.html"() {
      bookshop_bindings_default = '{{/*\n    Binds the next bookshop component to a given front matter data source\n\n    Expects one argument, a string to use as the data binding in CloudCannon\n*/}}\n\n{{- (printf `<!--bookshop-live meta(version: "3.3.3" baseurl: "%s" copyright: "%s" title: "%s")-->` site.BaseURL site.Copyright site.Title) | safeHTML }}\n{{ $is_string := eq "string" (printf "%T" .) -}}\n\n{{- if $is_string -}}\n    {{ (printf "<!--bookshop-live name(__bookshop__subsequent) params(.: %s)-->" .) | safeHTML }}\n{{- else -}}\n    {{- $err := slice \n        (printf "bookshop_bindings expected a string but received \\"%s\\"" .)\n        "     The `bookshop_bindings` partial should be passed a string"\n        "     representation of the arguments to the component."\n        "     Example usage:"\n        " \u250C\u2500"\n        " \u2502    {{ partial \\"bookshop_bindings\\" `.Params.content_blocks` }}"\n        ` \u2502    {{ partial "bookshop_partial" (slice "page" .Params.content_blocks) }}`\n        " \u251C\u2500"\n        " \u2502    {{ partial \\"bookshop_bindings\\" `(dict \\"content_html\\" .Params.note_html \\"type\\" \\"note\\")` }}"\n        ` \u2502    {{ partial "bookshop" (slice "content" (dict "content_html" .Params.note_html "type" "note")) }}`\n        " \u2514\u2500"\n        "     NB: The bookshop_bindings partial is only required in site layouts."\n        "     It is not needed within Bookshop components."\n    -}}\n    {{- partial "_bookshop/errors/err" (delimit $err "\\n") -}}\n{{- end -}}\n';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/component.html
  var component_exports = {};
  __export(component_exports, {
    default: () => component_default
  });
  var component_default;
  var init_component = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/component.html"() {
      component_default = '{{/*\n    Renders a single Bookshop component, \n    wrapping in in a live editing context tag.\n\n    Expects a slice:\n    [\n        <string>, # Component name\n        <_>       # Component props\n    ]\n*/}}\n\n{{- $component_name := index . 0 -}}\n{{- $component_props := index . 1 -}}\n{{- $component_path := partial "_bookshop/helpers/component_key" $component_name -}}\n{{- $flat_component_path := partial "_bookshop/helpers/flat_component_key" $component_name -}}\n\n{{- $resolved_component := false -}}\n{{- if templates.Exists ( printf "partials/%s" $component_path ) -}}\n    {{- $resolved_component = $component_path -}}\n{{- else if templates.Exists ( printf "partials/%s" $flat_component_path ) -}}\n    {{- $resolved_component = $flat_component_path -}}\n{{- end -}}\n\n{{- if $resolved_component -}}\n\n{{/* Suppress comments when live editing {{ (printf "<!--bookshop-live name(%s)-->" $component_name) | safeHTML }} */}}\n{{- partial $resolved_component $component_props -}}\n{{/* Suppress comments when live editing {{ "<!--bookshop-live end-->" | safeHTML }} */}}\n\n{{- else -}}\n    {{- $file_loc := slicestr $component_path 9 -}}\n    {{- $flat_file_loc := slicestr $flat_component_path 9 -}}\n    {{- partial "_bookshop/errors/err" (printf "Component \\"%s\\" does not exist.\\n     Create this component by placing a file in your bookshop at %s or %s" $component_name $file_loc $flat_file_loc) -}}\n{{- end -}}\n';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/component_key.html
  var component_key_exports = {};
  __export(component_key_exports, {
    default: () => component_key_default
  });
  var component_key_default;
  var init_component_key = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/component_key.html"() {
      component_key_default = '{{/*\n    Converts a bare Bookshop component key to a Bookshop path\n    i.e. "a/b" --> "bookshop/components/a/b/b.hugo.html"\n\n    Expects a String.\n*/}}\n\n{{ $component_fragments := split . "/" }}\n{{ $component_fragments = append (last 1 $component_fragments) $component_fragments }}\n{{ $component_path := (printf "bookshop/components/%s.hugo.html" (delimit $component_fragments "/")) }}\n{{ return $component_path }}';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/flat_component_key.html
  var flat_component_key_exports = {};
  __export(flat_component_key_exports, {
    default: () => flat_component_key_default
  });
  var flat_component_key_default;
  var init_flat_component_key = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/flat_component_key.html"() {
      flat_component_key_default = '{{/*\n    Converts a bare Bookshop component key to a flat Bookshop path\n    i.e. "a/b" --> "bookshop/components/a/b.hugo.html"\n\n    Expects a String.\n*/}}\n\n{{ $component_path := (printf "bookshop/components/%s.hugo.html" .) }}\n{{ return $component_path }}';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/partial.html
  var partial_exports = {};
  __export(partial_exports, {
    default: () => partial_default
  });
  var partial_default;
  var init_partial = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/partial.html"() {
      partial_default = '{{/*\n    Renders a single Bookshop partial, \n    wrapping in in a live editing context tag.\n\n    Expects a slice:\n    [\n        <string>, # Partial name\n        <_>       # Partial props\n    ]\n*/}}\n\n{{- $partial_name := index . 0 -}}\n{{- $partial_props := index . 1 -}}\n{{- $partial_path := partial "_bookshop/helpers/partial_key" $partial_name -}}\n\n{{- if templates.Exists ( printf "partials/%s" $partial_path ) -}}\n\n{{/* Suppress comments when live editing {{ (printf "<!--bookshop-live name(%s)-->" $partial_name) | safeHTML }} */}}\n{{- partial $partial_path $partial_props -}}\n{{/* Suppress comments when live editing {{ "<!--bookshop-live end-->" | safeHTML }} */}}\n\n{{- else -}}\n    {{- $file_loc := slicestr $partial_path 9 -}}\n    {{- partial "_bookshop/errors/err" (printf "Partial \\"%s\\" does not exist.\\n     Create this partial by placing a file in your bookshop at %s" $partial_name $file_loc) -}}\n{{- end -}}\n';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/partial_key.html
  var partial_key_exports = {};
  __export(partial_key_exports, {
    default: () => partial_key_default
  });
  var partial_key_default;
  var init_partial_key = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/helpers/partial_key.html"() {
      partial_key_default = '{{/*\n    Converts a bare Bookshop partial key to a Bookshop path\n    i.e. "a" --> "bookshop/shared/hugo/a.hugo.html"\n\n    Expects a String.\n*/}}\n\n{{ $component_path := (printf "bookshop/shared/hugo/%s.hugo.html" .) }}\n{{ return $component_path }}';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/errors/bad_bookshop_tag.html
  var bad_bookshop_tag_exports = {};
  __export(bad_bookshop_tag_exports, {
    default: () => bad_bookshop_tag_default
  });
  var bad_bookshop_tag_default;
  var init_bad_bookshop_tag = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/errors/bad_bookshop_tag.html"() {
      bad_bookshop_tag_default = '{{/*\n    Prints examples of correct usage of the bookshop tag options\n\n    Expects a String containing a helpful error message.\n*/}}\n\n{{- $err := slice \n    .\n    "    The following Bookshop tag formats are valid:"\n    ""\n    "  \u25BA Render a \\"button\\" component with data:"\n    " \u250C\u2500"\n    " \u2502  {{ partial \\"bookshop\\" (slice \\"button\\" (dict \\"text\\" .button.text)) }}"\n    " \u251C\u2500"\n    " \u2502  {{ with (dict \\"text\\" .button.text) }}"\n    " \u2502     {{ partial \\"bookshop\\" (slice \\"button\\" .) }}"\n    " \u2502  {{ end }}"\n    " \u2514\u2500"\n    ""\n    "  \u25BA Render a component from a struct, where the struct contains a _bookshop_name key:"\n    " \u250C\u2500"\n    " \u2502  {{ partial \\"bookshop\\" (dict \\"_bookshop_name\\" \\"button\\" \\"text\\" .button.text) }}"\n    " \u251C\u2500"\n    " \u2502  {{ partial \\"bookshop\\" .Params.component_structure }}"\n    " \u2514\u2500"\n    ""\n    "  \u25BA Render a \\"logo\\" component with no data:"\n    " \u250C\u2500"\n    " \u2502  {{ partial \\"bookshop\\" \\"logo\\" }}"\n    " \u2514\u2500"\n    ""\n    "  \u25BA Render a \\"tag\\" partial with data:"\n    " \u250C\u2500"\n    " \u2502  {{ partial \\"bookshop_partial\\" (slice \\"tag\\" (dict \\"message\\" \\"Hello World\\")) }}"\n    " \u2514\u2500"\n    " "\n-}}\n{{- partial "_bookshop/errors/err" (delimit $err "\\n") -}}\n\n';
    }
  });

  // node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/errors/err.html
  var err_exports = {};
  __export(err_exports, {
    default: () => err_default
  });
  var err_default;
  var init_err = __esm({
    "node_modules/@bookshop/hugo-engine/bookshop-hugo-templates/errors/err.html"() {
      err_default = '{{/*\n    It is what it says on the box.\n*/}}\n\n{{ errorf "\u{1F4DA} Error from Bookshop:\\n\u{1F4DA}\u2755 %s" . }}\n{{ return true }}';
    }
  });

  // node_modules/@bookshop/live/lib/app/parsers/params-parser.js
  var TOKENS = {
    ASSIGN: /:|=/,
    DELIM: /"|'|`/,
    ESCAPE: /\\/,
    SPACE: /\s|\r|\n/,
    INSCOPE: /\(/,
    OUTSCOPE: /\)/,
    INDEX: /\[/,
    OUTDEX: /\]/
  };
  var ParamsParser = class {
    constructor(input) {
      this.input = input;
      this.stream = input.split("");
      this.state = `IDENT`;
      this.deps = {};
      this.output = [];
    }
    build() {
      while (this.stream.length) {
        this.process(this.stream.shift());
      }
      this.process(" ");
      return this.output;
    }
    process(t) {
      switch (this.state) {
        case `IDENT`:
          return this.processIDENT(t);
        case `VALUE`:
          return this.processVALUE(t);
      }
    }
    processIDENT(t) {
      if (TOKENS.SPACE.test(t) && !this.deps.started) {
        return;
      }
      ;
      this.deps.identifier = this.deps.identifier || "";
      this.deps.started = true;
      if (TOKENS.ASSIGN.test(t) && !this.deps.escape) {
        if (!this.deps.identifier) {
          throw new Error("No identifier provided");
        }
        this.state = "VALUE";
        this.deps = { identifier: this.deps.identifier };
        return;
      }
      if (TOKENS.ESCAPE.test(t) && !this.deps.escape) {
        return this.deps.escape = true;
      }
      this.deps.identifier += t;
      this.deps.escape = false;
    }
    processVALUE(t) {
      if (TOKENS.SPACE.test(t) && !this.deps.started) {
        return;
      }
      ;
      this.deps.value = this.deps.value || "";
      this.deps.started = true;
      if (this.deps.escape) {
        this.deps.value += t;
        this.deps.escape = false;
        return;
      }
      if (TOKENS.ESCAPE.test(t)) {
        this.deps.escape = true;
        return;
      }
      this.deps.value += t;
      if (!this.deps.delim) {
        if (TOKENS.DELIM.test(t)) {
          return this.deps.delim = new RegExp(t);
        }
        if (TOKENS.INSCOPE.test(t)) {
          return this.deps.delim = TOKENS.OUTSCOPE;
        }
        if (TOKENS.INDEX.test(t)) {
          return this.deps.delim = TOKENS.OUTDEX;
        }
        this.deps.delim = TOKENS.SPACE;
        if (!TOKENS.SPACE.test(t)) {
          return;
        }
      }
      if (this.deps.delimDepth && this.deps.delim.test(t)) {
        return this.deps.delimDepth -= 1;
      }
      if (this.deps.delim === TOKENS.SPACE && this.deps.delim.test(t)) {
        this.deps.value = this.deps.value.replace(/.$/, "");
        this.deps.value = this.deps.value.replace(/^\(\(+(.+)\)+\)$/, "($1)");
        this.deps.value = this.deps.value.replace(/^\((\S+)\)$/, "$1");
        this.output.push([this.deps.identifier, this.deps.value]);
        this.state = "IDENT";
        this.deps = {};
        return;
      }
      if (this.deps.delim.test(t)) {
        this.deps.delim = null;
        return;
      }
      if (this.deps.delim === TOKENS.OUTSCOPE && TOKENS.INSCOPE.test(t)) {
        this.deps.delimDepth = this.deps.delimDepth || 0;
        this.deps.delimDepth += 1;
      }
    }
  };

  // node_modules/@bookshop/live/lib/app/parsers/comment-parser.js
  var TOKENS2 = {
    ESCAPE: /\\/,
    SPACE: /\s|\r|\n/,
    INSCOPE: /\(/,
    OUTSCOPE: /\)/,
    END: /END/
  };
  var CommentParser = class {
    constructor(input) {
      this.input = input;
      this.stream = input.split("");
      this.state = `IDENT`;
      this.deps = {};
      this.output = {};
    }
    build() {
      while (this.stream.length) {
        this.process(this.stream.shift());
      }
      this.process("END");
      return this.output;
    }
    process(t) {
      switch (this.state) {
        case `IDENT`:
          return this.processIDENT(t);
        case `VALUE`:
          return this.processVALUE(t);
      }
    }
    processIDENT(t) {
      if (TOKENS2.SPACE.test(t) && !this.deps.started) {
        return;
      }
      ;
      this.deps.identifier = this.deps.identifier || "";
      this.deps.started = true;
      if (TOKENS2.END.test(t)) {
        if (this.deps.identifier) {
          this.output[this.deps.identifier] = true;
        }
        return;
      }
      if (TOKENS2.INSCOPE.test(t) && !this.deps.escape) {
        if (!this.deps.identifier) {
          throw new Error("No identifier provided");
        }
        this.state = "VALUE";
        this.deps = { identifier: this.deps.identifier };
        return;
      }
      if (TOKENS2.ESCAPE.test(t) && !this.deps.escape) {
        return this.deps.escape = true;
      }
      this.deps.identifier += t;
      this.deps.escape = false;
    }
    processVALUE(t) {
      if (TOKENS2.SPACE.test(t) && !this.deps.started) {
        return;
      }
      ;
      this.deps.value = this.deps.value || "";
      this.deps.started = true;
      if (this.deps.escape) {
        this.deps.value += t;
        this.deps.escape = false;
        return;
      }
      if (TOKENS2.OUTSCOPE.test(t) && !this.deps.delimDepth) {
        this.output[this.deps.identifier] = this.deps.value;
        this.state = "IDENT";
        this.deps = {};
        return;
      }
      if (TOKENS2.ESCAPE.test(t)) {
        this.deps.escape = true;
        return;
      }
      this.deps.value += t;
      if (TOKENS2.INSCOPE.test(t)) {
        this.deps.delimDepth = this.deps.delimDepth || 0;
        this.deps.delimDepth += 1;
      }
      if (TOKENS2.OUTSCOPE.test(t) && this.deps.delimDepth) {
        this.deps.delimDepth -= 1;
      }
    }
  };

  // node_modules/@bookshop/live/lib/app/core.js
  var normalizeName = (name) => name.replace(/\/[\w-]+\..+$/, "").replace(/\..+$/, "");
  var parseParams = (params) => params ? new ParamsParser(params).build() : [];
  var getTemplateCommentIterator = (node) => {
    const documentNode = node.ownerDocument ?? document;
    return documentNode.evaluate("//comment()[contains(.,'bookshop-live')]", node, null, XPathResult.ANY_TYPE, null);
  };
  var parseComment = (node) => {
    return new CommentParser(node.textContent.replace(/^bookshop-live /, "")).build();
  };
  var nodeIsBefore = (a, b) => {
    return a && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  };
  var bookshop_version = null;
  if (true) {
    bookshop_version = "3.6.5";
  }
  var storeResolvedPath = (name, identifier, pathStack, logger) => {
    if (typeof identifier !== "string")
      return;
    const splitIdentifier = identifier.replace(/^include\./, "").replace(/\[(\d+)]/g, ".$1").split(".");
    logger?.log?.(`Split ${identifier} info ${JSON.stringify(splitIdentifier)}`);
    const baseIdentifier = splitIdentifier.shift();
    logger?.log?.(`Using base identifier ${baseIdentifier}`);
    if (baseIdentifier) {
      const existingPath = findInStack(baseIdentifier, pathStack);
      logger?.log?.(`Found the existing path ${existingPath}`);
      const prefix = existingPath ?? baseIdentifier;
      logger?.log?.(`Using the prefix ${prefix}`);
      pathStack[pathStack.length - 1][name] = `${[prefix, ...splitIdentifier].join(".")}`;
    } else {
      const existingPath = findInStack(identifier, pathStack);
      logger?.log?.(`Found the existing path ${existingPath}`);
      const path = existingPath ?? identifier;
      logger?.log?.(`Using the path ${path}`);
      pathStack[pathStack.length - 1][name] = path;
    }
    logger?.log?.(`Stored ${name}: ${pathStack[pathStack.length - 1][name]}`);
  };
  var findInStack = (key, stack) => {
    const [baseIdentifier, ...rest] = key?.split?.(".");
    if (baseIdentifier) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i][baseIdentifier]) {
          if (rest.length)
            return `${stack[i][baseIdentifier]}.${rest.join(".")}`;
          return `${stack[i][baseIdentifier]}`;
        }
        if (stack[i]["."] && stack[i]["."] !== "." && !/^(\$|Params)/.test(key)) {
          return `${stack[i]["."]}.${key}`;
        }
      }
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i][key]) {
        return `${stack[i][key]}`;
      }
    }
    return null;
  };
  var dig = (obj, path) => {
    if (typeof path === "string" && /^\s*['"`]/.test(path))
      return false;
    if (typeof path === "string")
      path = path.replace(/\[(\d+)]/g, ".$1").split(".");
    obj = obj[path.shift()];
    if (obj && path.length)
      return dig(obj, path);
    return obj;
  };
  var replaceHTMLRegion = (startNode, endNode, outputElement) => {
    let node = startNode.nextSibling;
    while (node && (node.compareDocumentPosition(endNode) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    while (outputElement.childNodes.length) {
      endNode.parentNode.insertBefore(outputElement.childNodes[0], endNode);
    }
  };
  var evaluateTemplate = async (opts) => {
    const {
      liveInstance,
      documentNode,
      parentPathStack,
      templateBlockHandler,
      isRetry,
      logger,
      processDeepComponents = true
    } = opts;
    const stack = [{ scope: {} }];
    const pathStack = parentPathStack || [{}];
    let stashedNodes = [];
    let stashedParams = [];
    let meta = {};
    const combinedScope = () => [liveInstance.data, ...stack.map((s) => s.scope)];
    const currentScope = () => stack[stack.length - 1];
    const iterator = getTemplateCommentIterator(documentNode);
    let currentNode = iterator.iterateNext();
    while (currentNode) {
      logger?.log?.(`Parsing the comment:`);
      logger?.log?.(currentNode.textContent);
      const liveTag = parseComment(currentNode);
      if (!liveInstance.storedMeta) {
        for (const [name, identifier] of parseParams(liveTag?.meta)) {
          meta[name] = identifier;
          logger?.log?.(`Registered metadata ${name} as ${identifier}`);
          if (name === "version" && bookshop_version) {
            const expected_version = await liveInstance.eval(identifier, combinedScope(), logger?.nested?.());
            if (expected_version !== bookshop_version) {
              console.error([
                `Your Bookshop SSG plugin is running version ${expected_version}, but @bookshop/live is running version ${bookshop_version}.`,
                `Bookshop follows semantic versioning with regard to your site and components,`,
                `but this does not extend to Bookshop packages being compatible with each other across any version jump.`,
                `
Run %cnpx @bookshop/up@latest%c in your root directory to upgrade all Bookshop dependencies.`
              ].join("\n"), `color: #FF4C29; font-family: monospace; font-weight: bold;`, `color: unset; font-family: unset; font-weight: unset;`);
            }
          }
          liveInstance.storedMeta = true;
        }
        await liveInstance.storeMeta(meta);
      }
      for (const [name, identifier] of parseParams(liveTag?.context)) {
        const componentDepth = stack.length - 1;
        if (componentDepth == 0 || processDeepComponents === true) {
          logger?.log?.(`Parsing context ${name}: ${identifier}`);
          currentScope().scope[name] = await liveInstance.eval(identifier, combinedScope(), logger?.nested?.());
          const normalizedIdentifier = liveInstance.normalize(identifier, logger?.nested?.());
          if (typeof normalizedIdentifier === "object" && !Array.isArray(normalizedIdentifier)) {
            Object.values(normalizedIdentifier).forEach((value) => {
              return storeResolvedPath(name, value, pathStack, logger?.nested?.());
            });
          } else {
            storeResolvedPath(name, normalizedIdentifier, pathStack, logger?.nested?.());
          }
        } else {
          logger?.log?.(`Skipping deep context of ${name}: ${identifier}`);
        }
      }
      for (const [name, identifier] of parseParams(liveTag?.reassign)) {
        const componentDepth = stack.length - 1;
        if (componentDepth == 0 || processDeepComponents === true) {
          logger?.log?.(`Reassigning ${name} to ${identifier}`);
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            if (stack[i].scope[name] !== void 0) {
              stack[i].scope[name] = await liveInstance.eval(identifier, combinedScope(), logger?.nested?.());
              break;
            }
          }
          for (let i = pathStack.length - 1; i >= 0; i -= 1) {
            if (pathStack[i][name] !== void 0) {
              const normalizedIdentifier = liveInstance.normalize(identifier, logger?.nested?.());
              if (typeof normalizedIdentifier === "object" && !Array.isArray(normalizedIdentifier)) {
                Object.values(normalizedIdentifier).forEach((value) => {
                  return storeResolvedPath(name, value, [pathStack[i]]);
                });
              } else {
                storeResolvedPath(name, normalizedIdentifier, [pathStack[i]]);
              }
              break;
            }
          }
        } else {
          logger?.log?.(`Skipping deep reassignment of ${name} to ${identifier}`);
        }
      }
      if (liveTag?.end) {
        logger?.log?.(`Reached the end of a block, handing off to the handler function`);
        currentScope().endNode = currentNode;
        await templateBlockHandler(stack.pop(), logger?.nested?.());
        pathStack.pop();
      } else if (liveTag.stack) {
        logger?.log?.(`Stacking a new context`);
        let scope = {};
        pathStack.push({});
        stack.push({
          pathStack: JSON.parse(JSON.stringify(pathStack)),
          scope
        });
      } else if (liveTag.unstack) {
        logger?.log?.(`Unstacking a context`);
        stack.pop();
        pathStack.pop();
      } else if (liveTag && liveTag?.name === "__bookshop__subsequent") {
        logger?.log?.(`Stashing parameters for the next bookshop tag`);
        stashedNodes.push(currentNode);
        stashedParams = [...stashedParams, ...parseParams(liveTag?.params)];
      } else if (liveTag?.name) {
        const componentDepth = stack.length - 1;
        if (componentDepth == 0 || processDeepComponents === true) {
          logger?.log?.(`Rendering a new component ${liveTag.name}`);
          let scope = {};
          const params = [...stashedParams, ...parseParams(liveTag?.params)];
          pathStack.push({});
          for (const [name, identifier] of params) {
            if (name === "bind") {
              const bindVals = await liveInstance.eval(identifier, combinedScope(), logger?.nested?.());
              if (bindVals && typeof bindVals === "object") {
                scope = { ...scope, ...bindVals };
                Object.keys(bindVals).forEach((key) => storeResolvedPath(key, `${identifier}.${key}`, pathStack));
              }
            } else if (name === ".") {
              const bindVals = await liveInstance.eval(identifier, combinedScope(), logger?.nested?.());
              if (bindVals && typeof bindVals === "object" && !Array.isArray(bindVals)) {
                scope = { ...scope, ...bindVals };
              } else {
                scope[name] = bindVals;
              }
              const normalizedIdentifier = liveInstance.normalize(identifier, logger?.nested?.());
              if (typeof normalizedIdentifier === "object" && !Array.isArray(normalizedIdentifier)) {
                Object.entries(normalizedIdentifier).forEach(([key, value]) => {
                  return storeResolvedPath(key, value, pathStack);
                });
              } else {
                storeResolvedPath(name, normalizedIdentifier, pathStack);
              }
            } else {
              scope[name] = await liveInstance.eval(identifier, combinedScope(), logger?.nested?.());
              storeResolvedPath(name, identifier, pathStack);
            }
          }
          ;
          stack.push({
            startNode: currentNode,
            name: normalizeName(liveTag?.name),
            pathStack: JSON.parse(JSON.stringify(pathStack)),
            scope,
            params,
            stashedNodes,
            depth: componentDepth
          });
        } else {
          logger?.log?.(`Skipping deep render of ${liveTag.name}`);
          pathStack.push({});
          stack.push({
            startNode: currentNode,
            name: normalizeName(liveTag?.name),
            depth: componentDepth
          });
        }
        stashedParams = [];
        stashedNodes = [];
      }
      try {
        currentNode = iterator.iterateNext();
      } catch (e) {
        logger?.log?.(`Failed to iterate to the next node.`);
        if (!isRetry) {
          logger?.log?.(`Trying to start again...`);
          return await evaluateTemplate(opts);
        }
      }
    }
  };
  var renderComponentUpdates = async (liveInstance, documentNode, logger) => {
    const vDom = document.implementation.createHTMLDocument();
    const updates = [];
    const templateBlockHandler = async ({ startNode, endNode, name, scope, pathStack, depth, stashedNodes }, logger2) => {
      logger2?.log?.(`Received a template block to render for ${name}`);
      if (depth) {
        logger2?.log?.(`Skipping render for nested component ${name}`);
        return;
      }
      ;
      const liveRenderFlag = scope?.live_render ?? scope?.liveRender ?? scope?._live_render ?? scope?._liveRender ?? true;
      if (!liveRenderFlag) {
        logger2?.log?.(`Skipping render for ${name} due to false liverender flag`);
        return;
      }
      ;
      const output = vDom.createElement("div");
      await liveInstance.renderElement(name, scope, output, logger2?.nested?.());
      logger2?.log?.(`Rendered ${name} block into an update`);
      updates.push({ startNode, endNode, output, pathStack, scope, name, stashedNodes });
    };
    logger?.log?.(`Evaluating templates found in a document`);
    await evaluateTemplate({
      liveInstance,
      documentNode,
      templateBlockHandler,
      isRetry: false,
      logger: logger?.nested?.(),
      processDeepComponents: false
    });
    logger?.log?.(`Completed evaluating the document`);
    return updates;
  };
  var findDataBinding = (identifier, liveInstance, pathStack, logger) => {
    logger?.log?.(`Finding the data binding for ${identifier}`);
    const normalizedIdentifier = liveInstance.normalize(identifier, logger?.nested?.());
    if (typeof normalizedIdentifier === "object") {
      for (const innerIdentifier of Object.values(normalizedIdentifier)) {
        logger?.log?.(`'twas an object \u2014 finding the data binding for ${innerIdentifier}'`);
        let dataBinding = findDataBinding(innerIdentifier, liveInstance, pathStack, logger?.nested?.());
        if (dataBinding)
          return dataBinding;
      }
      return null;
    }
    let path = findInStack(normalizedIdentifier, pathStack) ?? normalizedIdentifier;
    let pathResolves = dig(liveInstance.data, path);
    logger?.log?.(`Found the path ${path}, which ${pathResolves ? `does resolve` : `does not resolve`}`);
    if (pathResolves) {
      let dataBinding = path.replace(/^page(\.|$)/, "");
      dataBinding = dataBinding.replace(/^Params(\.|$)/, "");
      return dataBinding;
    }
  };
  var hydrateDataBindings = async (liveInstance, documentNode, pathsInScope, preComment, postComment, stashedNodes, logger) => {
    logger?.log?.(`Hydrating data bindings`);
    const vDom = documentNode.ownerDocument;
    const components = [];
    documentNode.prepend(preComment);
    for (let node of stashedNodes.reverse()) {
      logger?.log?.(`Adding a stashed node to the top of our document node`);
      documentNode.prepend(node);
    }
    documentNode.append(postComment);
    vDom.body.appendChild(documentNode);
    const templateBlockHandler = async (component, logger2) => {
      logger2?.log?.(`Storing an update for ${component.name}`);
      components.push(component);
    };
    logger?.log?.(`Evaluating template...`);
    await evaluateTemplate({
      liveInstance,
      documentNode,
      pathStack: [{}],
      templateBlockHandler,
      isRetry: false,
      logger: logger?.nested?.()
    });
    for (let { startNode, endNode, params, pathStack, scope, name } of components) {
      const isStandardComponent = liveInstance.resolveComponentType(name) === "component";
      const dataBindingFlag = scope?.editorLink ?? scope?.editor_link ?? scope?._editorLink ?? scope?._editor_link ?? scope?.dataBinding ?? scope?.data_binding ?? scope?._dataBinding ?? scope?._data_binding ?? isStandardComponent;
      if (dataBindingFlag) {
        let dataBinding = null;
        for (const [, identifier] of params) {
          dataBinding = findDataBinding(identifier, liveInstance, pathStack, logger?.nested?.());
          if (dataBinding)
            break;
        }
        if (dataBinding) {
          logger?.log?.(`Found the data binding ${dataBinding} for ${name}`);
          let node = startNode.nextElementSibling;
          while (node && (node.compareDocumentPosition(endNode) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
            logger?.log?.(`Setting data-cms-bind on an element`);
            node.dataset.cmsBind = `#${dataBinding}`;
            node = node.nextElementSibling;
          }
        } else {
          logger?.log?.(`Couldn't find a data binding for ${name}`);
        }
      } else {
        logger?.log?.(`${name} opted out of getting a data binding`);
      }
    }
    preComment.remove();
    postComment.remove();
    for (let node of stashedNodes) {
      node.remove();
    }
    documentNode.remove();
  };
  var graftTrees = (DOMStart, DOMEnd, vDOMObject, logger) => {
    let existingNodes = [], incomingNodes = [...vDOMObject.childNodes];
    let existingNode = DOMStart.nextSibling;
    while (nodeIsBefore(existingNode, DOMEnd)) {
      existingNodes.push(existingNode);
      existingNode = existingNode.nextSibling;
    }
    if (existingNodes.length !== incomingNodes.length) {
      logger?.log?.(`Trees are different lengths, replacing the entire region en-masse`);
      replaceHTMLRegion(DOMStart, DOMEnd, vDOMObject);
      return;
    }
    logger?.log?.(`Updating the tree...`);
    for (let i = 0; i < existingNodes.length; i++) {
      diffAndUpdateNode(existingNodes[i], incomingNodes[i]);
    }
  };
  var diffAndUpdateNode = (existingNode, incomingNode) => {
    if (existingNode.isEqualNode(incomingNode)) {
      return;
    }
    if (!existingNode.cloneNode(false).isEqualNode(incomingNode.cloneNode(false))) {
      existingNode.replaceWith(incomingNode);
      return;
    }
    if (existingNode.childNodes.length !== incomingNode.childNodes.length) {
      existingNode.replaceWith(incomingNode);
      return;
    }
    const existingChildren = [...existingNode.childNodes];
    const incomingChildren = [...incomingNode.childNodes];
    for (let i = 0; i < existingChildren.length; i++) {
      diffAndUpdateNode(existingChildren[i], incomingChildren[i]);
    }
  };

  // node_modules/@bookshop/live/lib/app/live.js
  var sleep = (ms = 0) => {
    return new Promise((r) => setTimeout(r, ms));
  };
  var getLive = (engines2) => class BookshopLive {
    constructor(options) {
      this.engines = engines2;
      this.elements = [];
      this.globalData = {};
      this.data = {};
      this.cloudcannonInfo = {};
      this.renderOptions = {};
      this.renderCount = 0;
      this.renderedAt = 0;
      this.shouldRenderAt = null;
      this.renderFrequency = 1e3;
      this.renderTimeout = null;
      this.verbose = false;
      this.lastLog = Date.now();
      this.storedMeta = false;
      this.memo = {};
      this.logFn = this.logger();
      this.loadedFn = options?.loadedFn;
      const remoteGlobals = options?.remoteGlobals?.length || 0;
      this.awaitingDataFetches = remoteGlobals + 1;
      options?.remoteGlobals?.forEach(this.fetchGlobalData.bind(this));
      this.fetchInfo();
    }
    completeRender() {
      if (typeof this.loadedFn === "function") {
        this.loadedFn();
        this.loadedFn = null;
      }
      this.renderCount += 1;
    }
    logger(depth = 0) {
      return {
        log: (str) => {
          if (this.verbose || typeof window !== "undefined" && window?.bookshopLiveVerbose) {
            console.log(`+${Date.now() - this.lastLog}ms : ${"|  ".repeat(depth)}${str}`);
          }
          this.lastLog = Date.now();
        },
        nested: () => this.logger(depth + 1)
      };
    }
    async fetchInfo() {
      try {
        this.logFn.log(`Trying to load /_cloudcannon/info.json`);
        const dataReq = await fetch(`/_cloudcannon/info.json`);
        this.cloudcannonInfo = await dataReq.json();
        await this.engines[0].storeInfo?.(this.cloudcannonInfo);
        this.awaitingDataFetches -= 1;
        this.logFn.log(`Loaded /_cloudcannon/info.json`);
      } catch (e) {
        this.awaitingDataFetches -= 1;
        this.logFn.log(`\u274C Failed to load /_cloudcannon/info.json`);
      }
    }
    async fetchGlobalData(path) {
      try {
        const dataReq = await fetch(path);
        const data = await dataReq.json();
        Object.assign(this.globalData, data);
        this.awaitingDataFetches -= 1;
      } catch (e) {
        this.awaitingDataFetches -= 1;
      }
    }
    readElement(el) {
      return {
        dom: el,
        originalHTML: el.innerHTML,
        componentName: el.dataset.bookshopLive,
        componentPropSource: el.dataset.bookshopProps
      };
    }
    resolveComponentType(componentName) {
      return this.engines[0].resolveComponentType(componentName);
    }
    async storeMeta(meta) {
      await this.engines[0].storeMeta?.(meta);
    }
    async renderElement(componentName, scope, dom, logger) {
      try {
        logger?.log?.(`Rendering ${componentName}`);
        await this.engines[0].render(dom, componentName, scope, { ...this.globalData }, logger?.nested?.());
        logger?.log?.(`Rendered ${componentName}`);
      } catch (e) {
        logger?.log?.(`Error rendering ${componentName}`);
        console.warn(`Error rendering bookshop component ${componentName}`, e.toString());
        console.warn(`This is expected in certain cases, and may not be an issue, especially when deleting or re-ordering components.`);
      }
    }
    async eval(identifier, scope, logger) {
      logger?.log?.(`Evaluating ${identifier} in ${JSON.stringify(scope)}`);
      const result = await this.engines[0].eval(identifier, scope, logger);
      logger?.log?.(`Evaluated to ${JSON.stringify(result)}`);
      return result;
    }
    normalize(identifier, logger) {
      const key = `Normalizing ${identifier}`;
      logger?.log?.(key);
      if (typeof this.engines[0].normalize === "function") {
        if (!this.memo[key]) {
          identifier = this.engines[0].normalize(identifier);
          this.memo[key] = identifier;
        } else {
          identifier = this.memo[key];
        }
        logger?.log?.(`Normalized to ${typeof identifier === "object" ? "json: " + JSON.stringify(identifier) : identifier}`);
      }
      return identifier;
    }
    async update(data, options) {
      this.logFn.log(`Received new data to update the page with`);
      const now = Date.now();
      if (typeof this.engines[0].transformData === "function" && options?.transformData !== false) {
        this.data = this.engines[0].transformData(data);
        this.logFn.log(`Transformed the data using the engine's transform function`);
      } else {
        this.data = data;
      }
      this.renderOptions = options;
      while (this.awaitingDataFetches > 0) {
        this.logFn.log(`Still fetching remote data, waiting for all fetches to complete...`);
        await sleep(100);
      }
      if (now - this.renderedAt < this.renderFrequency) {
        const shouldRenderAt = this.renderedAt + this.renderFrequency;
        this.shouldRenderAt = shouldRenderAt;
        this.logFn.log(`Throttling this render \u2014 will try to render again in ${shouldRenderAt - now}ms`);
        await sleep(shouldRenderAt - now);
        if (shouldRenderAt !== this.shouldRenderAt) {
          this.logFn.log(`A newer render has schedule itself \u2014 throwing away this render attempt`);
          return false;
        }
        this.logFn.log(`Now running previously throttled render`);
      }
      const realNow = Date.now();
      this.shouldRenderAt = null;
      this.renderedAt = Date.now();
      this.logFn.log(`Rendering the update`);
      await this.render();
      this.logFn.log(`Done rendering in ${Date.now() - realNow}ms (${Date.now() - now}ms throttled)`);
      return true;
    }
    async render() {
      const CCEditorPanelSupport = typeof window === "undefined" || typeof window !== "undefined" && window.CloudCannon?.refreshInterface;
      this.logFn.log(CCEditorPanelSupport ? `Editor panels are supported` : `Editor panels are not supported`);
      const options = {
        dataBindings: CCEditorPanelSupport,
        ...this.renderOptions
      };
      if (typeof window !== "undefined" && (window.bookshopEditorLinks === false || window.bookshopDataBindings === false)) {
        options.dataBindings = false;
      }
      if (options.editorLinks === false) {
        options.dataBindings = false;
      }
      this.logFn.log(options.dataBindings ? `Data bindings are enabled` : `Data bindings are disabled`);
      this.logFn.log(`Rendering component updates...`);
      const componentUpdates = await renderComponentUpdates(this, document, this.logFn.nested());
      this.logFn.log(`Individual component updates have been rendered`);
      for (let {
        startNode,
        endNode,
        output,
        pathStack,
        stashedNodes,
        name
      } of componentUpdates) {
        this.logFn.log(`Processing a component update for ${name}`);
        if (options.dataBindings) {
          this.logFn.log(`Hydrating the data bindings for ${name}`);
          await hydrateDataBindings(this, output, pathStack, startNode.cloneNode(), endNode.cloneNode(), stashedNodes.map((n) => n.cloneNode()), this.logFn.nested());
        }
        this.logFn.log(`Grafting ${name}'s update to the DOM tree`);
        graftTrees(startNode, endNode, output, this.logFn.nested());
        this.logFn.log(`Completed grafting ${name}'s update to the DOM tree`);
      }
      this.completeRender();
      this.logFn.log(`Finished rendering`);
    }
  };

  // node_modules/@bookshop/hugo-engine/full-hugo-renderer/hugo_renderer.wasm.gz
  var hugo_renderer_wasm_default = "./hugo_renderer.wasm-VCC627ZW.gz";

  // node_modules/fflate/esm/browser.js
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var u32 = Uint32Array;
  var fleb = new u8([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0]);
  var fdeb = new u8([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start) {
    var b = new u16(31);
    for (var i = 0; i < 31; ++i) {
      b[i] = start += 1 << eb[i - 1];
    }
    var r = new u32(b[30]);
    for (var i = 1; i < 30; ++i) {
      for (var j = b[i]; j < b[i + 1]; ++j) {
        r[j] = j - b[i] << 5 | i;
      }
    }
    return [b, r];
  };
  var _a = freb(fleb, 2);
  var fl = _a[0];
  var revfl = _a[1];
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b[0];
  var revfd = _b[1];
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >>> 1 | (i & 21845) << 1;
    x = (x & 52428) >>> 2 | (x & 13107) << 2;
    x = (x & 61680) >>> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >>> 8 | (x & 255) << 8) >>> 1;
  }
  var x;
  var i;
  var hMap = function(cd, mb, r) {
    var s = cd.length;
    var i = 0;
    var l = new u16(mb);
    for (; i < s; ++i) {
      if (cd[i])
        ++l[cd[i] - 1];
    }
    var le = new u16(mb);
    for (i = 0; i < mb; ++i) {
      le[i] = le[i - 1] + l[i - 1] << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          var sv = i << 4 | cd[i];
          var r_1 = mb - cd[i];
          var v = le[cd[i] - 1]++ << r_1;
          for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
            co[rev[v] >>> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          co[i] = rev[le[cd[i] - 1]++] >>> 15 - cd[i];
        }
      }
    }
    return co;
  };
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
  var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
  var max = function(a) {
    var m = a[0];
    for (var i = 1; i < a.length; ++i) {
      if (a[i] > m)
        m = a[i];
    }
    return m;
  };
  var bits = function(d, p, m) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
  };
  var bits16 = function(d, p) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
  };
  var shft = function(p) {
    return (p + 7) / 8 | 0;
  };
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    var n = new (v.BYTES_PER_ELEMENT == 2 ? u16 : v.BYTES_PER_ELEMENT == 4 ? u32 : u8)(e - s);
    n.set(v.subarray(s, e));
    return n;
  };
  var ec = [
    "unexpected EOF",
    "invalid block type",
    "invalid length/literal",
    "invalid distance",
    "stream finished",
    "no stream handler",
    ,
    "no callback",
    "invalid UTF-8 data",
    "extra field too long",
    "date not in range 1980-2099",
    "filename too long",
    "stream finishing",
    "invalid zip data"
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var inflt = function(dat, buf, st) {
    var sl = dat.length;
    if (!sl || st && st.f && !st.l)
      return buf || new u8(0);
    var noBuf = !buf || st;
    var noSt = !st || st.i;
    if (!st)
      st = {};
    if (!buf)
      buf = new u8(sl * 3);
    var cbuf = function(l2) {
      var bl = buf.length;
      if (l2 > bl) {
        var nbuf = new u8(Math.max(bl * 2, l2));
        nbuf.set(buf);
        buf = nbuf;
      }
    };
    var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
    var tbts = sl * 8;
    do {
      if (!lm) {
        final = bits(dat, pos, 1);
        var type = bits(dat, pos + 1, 3);
        pos += 3;
        if (!type) {
          var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
          if (t > sl) {
            if (noSt)
              err(0);
            break;
          }
          if (noBuf)
            cbuf(bt + l);
          buf.set(dat.subarray(s, t), bt);
          st.b = bt += l, st.p = pos = t * 8, st.f = final;
          continue;
        } else if (type == 1)
          lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
        else if (type == 2) {
          var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
          var tl = hLit + bits(dat, pos + 5, 31) + 1;
          pos += 14;
          var ldt = new u8(tl);
          var clt = new u8(19);
          for (var i = 0; i < hcLen; ++i) {
            clt[clim[i]] = bits(dat, pos + i * 3, 7);
          }
          pos += hcLen * 3;
          var clb = max(clt), clbmsk = (1 << clb) - 1;
          var clm = hMap(clt, clb, 1);
          for (var i = 0; i < tl; ) {
            var r = clm[bits(dat, pos, clbmsk)];
            pos += r & 15;
            var s = r >>> 4;
            if (s < 16) {
              ldt[i++] = s;
            } else {
              var c = 0, n = 0;
              if (s == 16)
                n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
              else if (s == 17)
                n = 3 + bits(dat, pos, 7), pos += 3;
              else if (s == 18)
                n = 11 + bits(dat, pos, 127), pos += 7;
              while (n--)
                ldt[i++] = c;
            }
          }
          var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
          lbt = max(lt);
          dbt = max(dt);
          lm = hMap(lt, lbt, 1);
          dm = hMap(dt, dbt, 1);
        } else
          err(1);
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
      }
      if (noBuf)
        cbuf(bt + 131072);
      var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
      var lpos = pos;
      for (; ; lpos = pos) {
        var c = lm[bits16(dat, pos) & lms], sym = c >>> 4;
        pos += c & 15;
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (!c)
          err(2);
        if (sym < 256)
          buf[bt++] = sym;
        else if (sym == 256) {
          lpos = pos, lm = null;
          break;
        } else {
          var add = sym - 254;
          if (sym > 264) {
            var i = sym - 257, b = fleb[i];
            add = bits(dat, pos, (1 << b) - 1) + fl[i];
            pos += b;
          }
          var d = dm[bits16(dat, pos) & dms], dsym = d >>> 4;
          if (!d)
            err(3);
          pos += d & 15;
          var dt = fd[dsym];
          if (dsym > 3) {
            var b = fdeb[dsym];
            dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
          }
          if (pos > tbts) {
            if (noSt)
              err(0);
            break;
          }
          if (noBuf)
            cbuf(bt + 131072);
          var end = bt + add;
          for (; bt < end; bt += 4) {
            buf[bt] = buf[bt - dt];
            buf[bt + 1] = buf[bt + 1 - dt];
            buf[bt + 2] = buf[bt + 2 - dt];
            buf[bt + 3] = buf[bt + 3 - dt];
          }
          bt = end;
        }
      }
      st.l = lm, st.p = lpos, st.b = bt, st.f = final;
      if (lm)
        final = 1, st.m = lbt, st.d = dm, st.n = dbt;
    } while (!final);
    return bt == buf.length ? buf : slc(buf, 0, bt);
  };
  var et = /* @__PURE__ */ new u8(0);
  var gzs = function(d) {
    if (d[0] != 31 || d[1] != 139 || d[2] != 8)
      err(6, "invalid gzip data");
    var flg = d[3];
    var st = 10;
    if (flg & 4)
      st += d[10] | (d[11] << 8) + 2;
    for (var zs = (flg >> 3 & 1) + (flg >> 4 & 1); zs > 0; zs -= !d[st++])
      ;
    return st + (flg & 2);
  };
  var gzl = function(d) {
    var l = d.length;
    return (d[l - 4] | d[l - 3] << 8 | d[l - 2] << 16 | d[l - 1] << 24) >>> 0;
  };
  function gunzipSync(data, out) {
    return inflt(data.subarray(gzs(data), -8), out || new u8(gzl(data)));
  }
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }

  // node_modules/liquidjs/dist/liquid.browser.esm.js
  var Drop = class {
    valueOf() {
      return void 0;
    }
    liquidMethodMissing(key) {
      return void 0;
    }
  };
  var toStr = Object.prototype.toString;
  var toLowerCase = String.prototype.toLowerCase;
  function isString(value) {
    return typeof value === "string";
  }
  function isFunction(value) {
    return typeof value === "function";
  }
  function toValue(value) {
    return value instanceof Drop ? value.valueOf() : value;
  }
  function isNil(value) {
    return value == null;
  }
  function isArray(value) {
    return toStr.call(value) === "[object Array]";
  }
  function last(arr) {
    return arr[arr.length - 1];
  }
  function isObject(value) {
    const type = typeof value;
    return value !== null && (type === "object" || type === "function");
  }
  function range(start, stop, step = 1) {
    const arr = [];
    for (let i = start; i < stop; i += step) {
      arr.push(i);
    }
    return arr;
  }
  function padStart(str, length, ch = " ") {
    return pad(str, length, ch, (str2, ch2) => ch2 + str2);
  }
  function padEnd(str, length, ch = " ") {
    return pad(str, length, ch, (str2, ch2) => str2 + ch2);
  }
  function pad(str, length, ch, add) {
    str = String(str);
    let n = length - str.length;
    while (n-- > 0)
      str = add(str, ch);
    return str;
  }
  function ellipsis(str, N) {
    return str.length > N ? str.substr(0, N - 3) + "..." : str;
  }
  function domResolve(root, path) {
    const base = document.createElement("base");
    base.href = root;
    const head = document.getElementsByTagName("head")[0];
    head.insertBefore(base, head.firstChild);
    const a = document.createElement("a");
    a.href = path;
    const resolved = a.href;
    head.removeChild(base);
    return resolved;
  }
  function resolve(root, filepath, ext) {
    if (root.length && last(root) !== "/")
      root += "/";
    const url = domResolve(root, filepath);
    return url.replace(/^(\w+:\/\/[^/]+)(\/[^?]+)/, (str, origin, path) => {
      const last2 = path.split("/").pop();
      if (/\.\w+$/.test(last2))
        return str;
      return origin + path + ext;
    });
  }
  async function readFile(url) {
    return new Promise((resolve2, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve2(xhr.responseText);
        } else {
          reject(new Error(xhr.statusText));
        }
      };
      xhr.onerror = () => {
        reject(new Error("An error occurred whilst receiving the response."));
      };
      xhr.open("GET", url);
      xhr.send();
    });
  }
  function readFileSync(url) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.send();
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(xhr.statusText);
    }
    return xhr.responseText;
  }
  async function exists(filepath) {
    return true;
  }
  function existsSync(filepath) {
    return true;
  }
  var fs = /* @__PURE__ */ Object.freeze({
    resolve,
    readFile,
    readFileSync,
    exists,
    existsSync
  });
  function isComparable(arg) {
    return arg && isFunction(arg.equals);
  }
  function isTruthy(val, ctx) {
    return !isFalsy(val, ctx);
  }
  function isFalsy(val, ctx) {
    if (ctx.opts.jsTruthy) {
      return !val;
    } else {
      return val === false || val === void 0 || val === null;
    }
  }
  var defaultOperators = {
    "==": (l, r) => {
      if (isComparable(l))
        return l.equals(r);
      if (isComparable(r))
        return r.equals(l);
      return l === r;
    },
    "!=": (l, r) => {
      if (isComparable(l))
        return !l.equals(r);
      if (isComparable(r))
        return !r.equals(l);
      return l !== r;
    },
    ">": (l, r) => {
      if (isComparable(l))
        return l.gt(r);
      if (isComparable(r))
        return r.lt(l);
      return l > r;
    },
    "<": (l, r) => {
      if (isComparable(l))
        return l.lt(r);
      if (isComparable(r))
        return r.gt(l);
      return l < r;
    },
    ">=": (l, r) => {
      if (isComparable(l))
        return l.geq(r);
      if (isComparable(r))
        return r.leq(l);
      return l >= r;
    },
    "<=": (l, r) => {
      if (isComparable(l))
        return l.leq(r);
      if (isComparable(r))
        return r.geq(l);
      return l <= r;
    },
    "contains": (l, r) => {
      return l && isFunction(l.indexOf) ? l.indexOf(r) > -1 : false;
    },
    "and": (l, r, ctx) => isTruthy(l, ctx) && isTruthy(r, ctx),
    "or": (l, r, ctx) => isTruthy(l, ctx) || isTruthy(r, ctx)
  };
  var TYPES = [0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 4, 4, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 2, 8, 0, 0, 0, 0, 8, 0, 0, 0, 64, 0, 65, 0, 0, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 0, 0, 2, 2, 2, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
  var IDENTIFIER = 1;
  var BLANK = 4;
  var QUOTE = 8;
  var INLINE_BLANK = 16;
  var NUMBER = 32;
  var SIGN = 64;
  TYPES[160] = TYPES[5760] = TYPES[6158] = TYPES[8192] = TYPES[8193] = TYPES[8194] = TYPES[8195] = TYPES[8196] = TYPES[8197] = TYPES[8198] = TYPES[8199] = TYPES[8200] = TYPES[8201] = TYPES[8202] = TYPES[8232] = TYPES[8233] = TYPES[8239] = TYPES[8287] = TYPES[12288] = BLANK;
  function createTrie(operators) {
    const trie = {};
    for (const [name, handler] of Object.entries(operators)) {
      let node = trie;
      for (let i = 0; i < name.length; i++) {
        const c = name[i];
        node[c] = node[c] || {};
        if (i === name.length - 1 && TYPES[name.charCodeAt(i)] & IDENTIFIER) {
          node[c].needBoundary = true;
        }
        node = node[c];
      }
      node.handler = handler;
      node.end = true;
    }
    return trie;
  }
  var defaultOptions = {
    root: ["."],
    layouts: ["."],
    partials: ["."],
    relativeReference: true,
    cache: void 0,
    extname: "",
    fs,
    dynamicPartials: true,
    jsTruthy: false,
    trimTagRight: false,
    trimTagLeft: false,
    trimOutputRight: false,
    trimOutputLeft: false,
    greedy: true,
    tagDelimiterLeft: "{%",
    tagDelimiterRight: "%}",
    outputDelimiterLeft: "{{",
    outputDelimiterRight: "}}",
    preserveTimezones: false,
    strictFilters: false,
    strictVariables: false,
    lenientIf: false,
    globals: {},
    keepOutputType: false,
    operators: defaultOperators,
    operatorsTrie: createTrie(defaultOperators)
  };
  var LiquidError = class extends Error {
    constructor(err2, token) {
      super(err2.message);
      this.originalError = err2;
      this.token = token;
      this.context = "";
    }
    update() {
      const err2 = this.originalError;
      this.context = mkContext(this.token);
      this.message = mkMessage(err2.message, this.token);
      this.stack = this.message + "\n" + this.context + "\n" + this.stack + "\nFrom " + err2.stack;
    }
  };
  var TokenizationError = class extends LiquidError {
    constructor(message, token) {
      super(new Error(message), token);
      this.name = "TokenizationError";
      super.update();
    }
  };
  var UndefinedVariableError = class extends LiquidError {
    constructor(err2, token) {
      super(err2, token);
      this.name = "UndefinedVariableError";
      this.message = err2.message;
      super.update();
    }
  };
  var AssertionError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "AssertionError";
      this.message = message + "";
    }
  };
  function mkContext(token) {
    const [line] = token.getPosition();
    const lines = token.input.split("\n");
    const begin = Math.max(line - 2, 1);
    const end = Math.min(line + 3, lines.length);
    const context = range(begin, end + 1).map((lineNumber) => {
      const indicator = lineNumber === line ? ">> " : "   ";
      const num = padStart(String(lineNumber), String(end).length);
      const text = lines[lineNumber - 1];
      return `${indicator}${num}| ${text}`;
    }).join("\n");
    return context;
  }
  function mkMessage(msg, token) {
    if (token.file)
      msg += `, file:${token.file}`;
    const [line, col] = token.getPosition();
    msg += `, line:${line}, col:${col}`;
    return msg;
  }
  var LookupType;
  (function(LookupType2) {
    LookupType2["Partials"] = "partials";
    LookupType2["Layouts"] = "layouts";
    LookupType2["Root"] = "root";
  })(LookupType || (LookupType = {}));
  var TokenKind;
  (function(TokenKind2) {
    TokenKind2[TokenKind2["Number"] = 1] = "Number";
    TokenKind2[TokenKind2["Literal"] = 2] = "Literal";
    TokenKind2[TokenKind2["Tag"] = 4] = "Tag";
    TokenKind2[TokenKind2["Output"] = 8] = "Output";
    TokenKind2[TokenKind2["HTML"] = 16] = "HTML";
    TokenKind2[TokenKind2["Filter"] = 32] = "Filter";
    TokenKind2[TokenKind2["Hash"] = 64] = "Hash";
    TokenKind2[TokenKind2["PropertyAccess"] = 128] = "PropertyAccess";
    TokenKind2[TokenKind2["Word"] = 256] = "Word";
    TokenKind2[TokenKind2["Range"] = 512] = "Range";
    TokenKind2[TokenKind2["Quoted"] = 1024] = "Quoted";
    TokenKind2[TokenKind2["Operator"] = 2048] = "Operator";
    TokenKind2[TokenKind2["Delimited"] = 12] = "Delimited";
  })(TokenKind || (TokenKind = {}));
  function isDelimitedToken(val) {
    return !!(getKind(val) & TokenKind.Delimited);
  }
  function isOperatorToken(val) {
    return getKind(val) === TokenKind.Operator;
  }
  function isHTMLToken(val) {
    return getKind(val) === TokenKind.HTML;
  }
  function isTagToken(val) {
    return getKind(val) === TokenKind.Tag;
  }
  function isQuotedToken(val) {
    return getKind(val) === TokenKind.Quoted;
  }
  function isLiteralToken(val) {
    return getKind(val) === TokenKind.Literal;
  }
  function isNumberToken(val) {
    return getKind(val) === TokenKind.Number;
  }
  function isPropertyAccessToken(val) {
    return getKind(val) === TokenKind.PropertyAccess;
  }
  function isWordToken(val) {
    return getKind(val) === TokenKind.Word;
  }
  function isRangeToken(val) {
    return getKind(val) === TokenKind.Range;
  }
  function getKind(val) {
    return val ? val.kind : -1;
  }
  function assert(predicate, message) {
    if (!predicate) {
      const msg = message ? message() : `expect ${predicate} to be true`;
      throw new AssertionError(msg);
    }
  }
  var NullDrop = class extends Drop {
    equals(value) {
      return isNil(toValue(value));
    }
    gt() {
      return false;
    }
    geq() {
      return false;
    }
    lt() {
      return false;
    }
    leq() {
      return false;
    }
    valueOf() {
      return null;
    }
  };
  var EmptyDrop = class extends Drop {
    equals(value) {
      if (value instanceof EmptyDrop)
        return false;
      value = toValue(value);
      if (isString(value) || isArray(value))
        return value.length === 0;
      if (isObject(value))
        return Object.keys(value).length === 0;
      return false;
    }
    gt() {
      return false;
    }
    geq() {
      return false;
    }
    lt() {
      return false;
    }
    leq() {
      return false;
    }
    valueOf() {
      return "";
    }
  };
  var BlankDrop = class extends EmptyDrop {
    equals(value) {
      if (value === false)
        return true;
      if (isNil(toValue(value)))
        return true;
      if (isString(value))
        return /^\s*$/.test(value);
      return super.equals(value);
    }
  };
  var nil = new NullDrop();
  var literalValues = {
    "true": true,
    "false": false,
    "nil": nil,
    "null": nil,
    "empty": new EmptyDrop(),
    "blank": new BlankDrop()
  };
  var rHex = /[\da-fA-F]/;
  var rOct = /[0-7]/;
  var escapeChar = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "	",
    v: "\v"
  };
  function hexVal(c) {
    const code = c.charCodeAt(0);
    if (code >= 97)
      return code - 87;
    if (code >= 65)
      return code - 55;
    return code - 48;
  }
  function parseStringLiteral(str) {
    let ret = "";
    for (let i = 1; i < str.length - 1; i++) {
      if (str[i] !== "\\") {
        ret += str[i];
        continue;
      }
      if (escapeChar[str[i + 1]] !== void 0) {
        ret += escapeChar[str[++i]];
      } else if (str[i + 1] === "u") {
        let val = 0;
        let j = i + 2;
        while (j <= i + 5 && rHex.test(str[j])) {
          val = val * 16 + hexVal(str[j++]);
        }
        i = j - 1;
        ret += String.fromCharCode(val);
      } else if (!rOct.test(str[i + 1])) {
        ret += str[++i];
      } else {
        let j = i + 1;
        let val = 0;
        while (j <= i + 3 && rOct.test(str[j])) {
          val = val * 8 + hexVal(str[j++]);
        }
        i = j - 1;
        ret += String.fromCharCode(val);
      }
    }
    return ret;
  }
  var Expression = class {
    constructor(tokens2) {
      this.postfix = [...toPostfix(tokens2)];
    }
    *evaluate(ctx, lenient) {
      assert(ctx, () => "unable to evaluate: context not defined");
      const operands = [];
      for (const token of this.postfix) {
        if (isOperatorToken(token)) {
          const r = yield operands.pop();
          const l = yield operands.pop();
          const result = evalOperatorToken(ctx.opts.operators, token, l, r, ctx);
          operands.push(result);
        } else {
          operands.push(yield evalToken(token, ctx, lenient && this.postfix.length === 1));
        }
      }
      return operands[0];
    }
  };
  function evalToken(token, ctx, lenient = false) {
    if (isPropertyAccessToken(token))
      return evalPropertyAccessToken(token, ctx, lenient);
    if (isRangeToken(token))
      return evalRangeToken(token, ctx);
    if (isLiteralToken(token))
      return evalLiteralToken(token);
    if (isNumberToken(token))
      return evalNumberToken(token);
    if (isWordToken(token))
      return token.getText();
    if (isQuotedToken(token))
      return evalQuotedToken(token);
  }
  function evalPropertyAccessToken(token, ctx, lenient) {
    const props = token.props.map((prop) => evalToken(prop, ctx, false));
    try {
      return ctx.get([token.propertyName, ...props]);
    } catch (e) {
      if (lenient && e.name === "InternalUndefinedVariableError")
        return null;
      throw new UndefinedVariableError(e, token);
    }
  }
  function evalNumberToken(token) {
    const str = token.whole.content + "." + (token.decimal ? token.decimal.content : "");
    return Number(str);
  }
  function evalQuotedToken(token) {
    return parseStringLiteral(token.getText());
  }
  function evalOperatorToken(operators, token, lhs, rhs, ctx) {
    const impl = operators[token.operator];
    return impl(lhs, rhs, ctx);
  }
  function evalLiteralToken(token) {
    return literalValues[token.literal];
  }
  function evalRangeToken(token, ctx) {
    const low = evalToken(token.lhs, ctx);
    const high = evalToken(token.rhs, ctx);
    return range(+low, +high + 1);
  }
  function* toPostfix(tokens2) {
    const ops = [];
    for (const token of tokens2) {
      if (isOperatorToken(token)) {
        while (ops.length && ops[ops.length - 1].getPrecedence() > token.getPrecedence()) {
          yield ops.pop();
        }
        ops.push(token);
      } else
        yield token;
    }
    while (ops.length) {
      yield ops.pop();
    }
  }
  var Token = class {
    constructor(kind, input, begin, end, file) {
      this.kind = kind;
      this.input = input;
      this.begin = begin;
      this.end = end;
      this.file = file;
    }
    getText() {
      return this.input.slice(this.begin, this.end);
    }
    getPosition() {
      let [row, col] = [1, 1];
      for (let i = 0; i < this.begin; i++) {
        if (this.input[i] === "\n") {
          row++;
          col = 1;
        } else
          col++;
      }
      return [row, col];
    }
    size() {
      return this.end - this.begin;
    }
  };
  var DelimitedToken = class extends Token {
    constructor(kind, content, input, begin, end, trimLeft2, trimRight2, file) {
      super(kind, input, begin, end, file);
      this.trimLeft = false;
      this.trimRight = false;
      this.content = this.getText();
      const tl = content[0] === "-";
      const tr = last(content) === "-";
      this.content = content.slice(tl ? 1 : 0, tr ? -1 : content.length).trim();
      this.trimLeft = tl || trimLeft2;
      this.trimRight = tr || trimRight2;
    }
  };
  function whiteSpaceCtrl(tokens2, options) {
    let inRaw = false;
    for (let i = 0; i < tokens2.length; i++) {
      const token = tokens2[i];
      if (!isDelimitedToken(token))
        continue;
      if (!inRaw && token.trimLeft) {
        trimLeft(tokens2[i - 1], options.greedy);
      }
      if (isTagToken(token)) {
        if (token.name === "raw")
          inRaw = true;
        else if (token.name === "endraw")
          inRaw = false;
      }
      if (!inRaw && token.trimRight) {
        trimRight(tokens2[i + 1], options.greedy);
      }
    }
  }
  function trimLeft(token, greedy) {
    if (!token || !isHTMLToken(token))
      return;
    const mask = greedy ? BLANK : INLINE_BLANK;
    while (TYPES[token.input.charCodeAt(token.end - 1 - token.trimRight)] & mask)
      token.trimRight++;
  }
  function trimRight(token, greedy) {
    if (!token || !isHTMLToken(token))
      return;
    const mask = greedy ? BLANK : INLINE_BLANK;
    while (TYPES[token.input.charCodeAt(token.begin + token.trimLeft)] & mask)
      token.trimLeft++;
    if (token.input.charAt(token.begin + token.trimLeft) === "\n")
      token.trimLeft++;
  }
  var NumberToken = class extends Token {
    constructor(whole, decimal) {
      super(TokenKind.Number, whole.input, whole.begin, decimal ? decimal.end : whole.end, whole.file);
      this.whole = whole;
      this.decimal = decimal;
    }
  };
  var IdentifierToken = class extends Token {
    constructor(input, begin, end, file) {
      super(TokenKind.Word, input, begin, end, file);
      this.input = input;
      this.begin = begin;
      this.end = end;
      this.file = file;
      this.content = this.getText();
    }
    isNumber(allowSign = false) {
      const begin = allowSign && TYPES[this.input.charCodeAt(this.begin)] & SIGN ? this.begin + 1 : this.begin;
      for (let i = begin; i < this.end; i++) {
        if (!(TYPES[this.input.charCodeAt(i)] & NUMBER))
          return false;
      }
      return true;
    }
  };
  var LiteralToken = class extends Token {
    constructor(input, begin, end, file) {
      super(TokenKind.Literal, input, begin, end, file);
      this.input = input;
      this.begin = begin;
      this.end = end;
      this.file = file;
      this.literal = this.getText();
    }
  };
  var precedence = {
    "==": 1,
    "!=": 1,
    ">": 1,
    "<": 1,
    ">=": 1,
    "<=": 1,
    "contains": 1,
    "and": 0,
    "or": 0
  };
  var OperatorToken = class extends Token {
    constructor(input, begin, end, file) {
      super(TokenKind.Operator, input, begin, end, file);
      this.input = input;
      this.begin = begin;
      this.end = end;
      this.file = file;
      this.operator = this.getText();
    }
    getPrecedence() {
      const key = this.getText();
      return key in precedence ? precedence[key] : 1;
    }
  };
  var PropertyAccessToken = class extends Token {
    constructor(variable, props, end) {
      super(TokenKind.PropertyAccess, variable.input, variable.begin, end, variable.file);
      this.variable = variable;
      this.props = props;
      this.propertyName = this.variable instanceof IdentifierToken ? this.variable.getText() : parseStringLiteral(this.variable.getText());
    }
  };
  var FilterToken = class extends Token {
    constructor(name, args, input, begin, end, file) {
      super(TokenKind.Filter, input, begin, end, file);
      this.name = name;
      this.args = args;
    }
  };
  var HashToken = class extends Token {
    constructor(input, begin, end, name, value, file) {
      super(TokenKind.Hash, input, begin, end, file);
      this.input = input;
      this.begin = begin;
      this.end = end;
      this.name = name;
      this.value = value;
      this.file = file;
    }
  };
  var QuotedToken = class extends Token {
    constructor(input, begin, end, file) {
      super(TokenKind.Quoted, input, begin, end, file);
      this.input = input;
      this.begin = begin;
      this.end = end;
      this.file = file;
    }
  };
  var HTMLToken = class extends Token {
    constructor(input, begin, end, file) {
      super(TokenKind.HTML, input, begin, end, file);
      this.input = input;
      this.begin = begin;
      this.end = end;
      this.file = file;
      this.trimLeft = 0;
      this.trimRight = 0;
    }
    getContent() {
      return this.input.slice(this.begin + this.trimLeft, this.end - this.trimRight);
    }
  };
  var RangeToken = class extends Token {
    constructor(input, begin, end, lhs, rhs, file) {
      super(TokenKind.Range, input, begin, end, file);
      this.input = input;
      this.begin = begin;
      this.end = end;
      this.lhs = lhs;
      this.rhs = rhs;
      this.file = file;
    }
  };
  var OutputToken = class extends DelimitedToken {
    constructor(input, begin, end, options, file) {
      const { trimOutputLeft, trimOutputRight, outputDelimiterLeft, outputDelimiterRight } = options;
      const value = input.slice(begin + outputDelimiterLeft.length, end - outputDelimiterRight.length);
      super(TokenKind.Output, value, input, begin, end, trimOutputLeft, trimOutputRight, file);
    }
  };
  function matchOperator(str, begin, trie, end = str.length) {
    let node = trie;
    let i = begin;
    let info;
    while (node[str[i]] && i < end) {
      node = node[str[i++]];
      if (node["end"])
        info = node;
    }
    if (!info)
      return -1;
    if (info["needBoundary"] && TYPES[str.charCodeAt(i)] & IDENTIFIER)
      return -1;
    return i;
  }
  var Tokenizer = class {
    constructor(input, trie, file = "") {
      this.input = input;
      this.trie = trie;
      this.file = file;
      this.p = 0;
      this.rawBeginAt = -1;
      this.N = input.length;
    }
    readExpression() {
      return new Expression(this.readExpressionTokens());
    }
    *readExpressionTokens() {
      const operand = this.readValue();
      if (!operand)
        return;
      yield operand;
      while (this.p < this.N) {
        const operator = this.readOperator();
        if (!operator)
          return;
        const operand2 = this.readValue();
        if (!operand2)
          return;
        yield operator;
        yield operand2;
      }
    }
    readOperator() {
      this.skipBlank();
      const end = matchOperator(this.input, this.p, this.trie, this.p + 8);
      if (end === -1)
        return;
      return new OperatorToken(this.input, this.p, this.p = end, this.file);
    }
    readFilters() {
      const filters = [];
      while (true) {
        const filter = this.readFilter();
        if (!filter)
          return filters;
        filters.push(filter);
      }
    }
    readFilter() {
      this.skipBlank();
      if (this.end())
        return null;
      assert(this.peek() === "|", () => `unexpected token at ${this.snapshot()}`);
      this.p++;
      const begin = this.p;
      const name = this.readIdentifier();
      if (!name.size())
        return null;
      const args = [];
      this.skipBlank();
      if (this.peek() === ":") {
        do {
          ++this.p;
          const arg = this.readFilterArg();
          arg && args.push(arg);
          while (this.p < this.N && this.peek() !== "," && this.peek() !== "|")
            ++this.p;
        } while (this.peek() === ",");
      }
      return new FilterToken(name.getText(), args, this.input, begin, this.p, this.file);
    }
    readFilterArg() {
      const key = this.readValue();
      if (!key)
        return;
      this.skipBlank();
      if (this.peek() !== ":")
        return key;
      ++this.p;
      const value = this.readValue();
      return [key.getText(), value];
    }
    readTopLevelTokens(options = defaultOptions) {
      const tokens2 = [];
      while (this.p < this.N) {
        const token = this.readTopLevelToken(options);
        tokens2.push(token);
      }
      whiteSpaceCtrl(tokens2, options);
      return tokens2;
    }
    readTopLevelToken(options) {
      const { tagDelimiterLeft, outputDelimiterLeft } = options;
      if (this.rawBeginAt > -1)
        return this.readEndrawOrRawContent(options);
      if (this.match(tagDelimiterLeft))
        return this.readTagToken(options);
      if (this.match(outputDelimiterLeft))
        return this.readOutputToken(options);
      return this.readHTMLToken(options);
    }
    readHTMLToken(options) {
      const begin = this.p;
      while (this.p < this.N) {
        const { tagDelimiterLeft, outputDelimiterLeft } = options;
        if (this.match(tagDelimiterLeft))
          break;
        if (this.match(outputDelimiterLeft))
          break;
        ++this.p;
      }
      return new HTMLToken(this.input, begin, this.p, this.file);
    }
    readTagToken(options = defaultOptions) {
      const { file, input } = this;
      const begin = this.p;
      if (this.readToDelimiter(options.tagDelimiterRight) === -1) {
        throw this.mkError(`tag ${this.snapshot(begin)} not closed`, begin);
      }
      const token = new TagToken(input, begin, this.p, options, file);
      if (token.name === "raw")
        this.rawBeginAt = begin;
      return token;
    }
    readToDelimiter(delimiter) {
      while (this.p < this.N) {
        if (this.peekType() & QUOTE) {
          this.readQuoted();
          continue;
        }
        ++this.p;
        if (this.rmatch(delimiter))
          return this.p;
      }
      return -1;
    }
    readOutputToken(options = defaultOptions) {
      const { file, input } = this;
      const { outputDelimiterRight } = options;
      const begin = this.p;
      if (this.readToDelimiter(outputDelimiterRight) === -1) {
        throw this.mkError(`output ${this.snapshot(begin)} not closed`, begin);
      }
      return new OutputToken(input, begin, this.p, options, file);
    }
    readEndrawOrRawContent(options) {
      const { tagDelimiterLeft, tagDelimiterRight } = options;
      const begin = this.p;
      let leftPos = this.readTo(tagDelimiterLeft) - tagDelimiterLeft.length;
      while (this.p < this.N) {
        if (this.readIdentifier().getText() !== "endraw") {
          leftPos = this.readTo(tagDelimiterLeft) - tagDelimiterLeft.length;
          continue;
        }
        while (this.p <= this.N) {
          if (this.rmatch(tagDelimiterRight)) {
            const end = this.p;
            if (begin === leftPos) {
              this.rawBeginAt = -1;
              return new TagToken(this.input, begin, end, options, this.file);
            } else {
              this.p = leftPos;
              return new HTMLToken(this.input, begin, leftPos, this.file);
            }
          }
          if (this.rmatch(tagDelimiterLeft))
            break;
          this.p++;
        }
      }
      throw this.mkError(`raw ${this.snapshot(this.rawBeginAt)} not closed`, begin);
    }
    mkError(msg, begin) {
      return new TokenizationError(msg, new IdentifierToken(this.input, begin, this.N, this.file));
    }
    snapshot(begin = this.p) {
      return JSON.stringify(ellipsis(this.input.slice(begin), 16));
    }
    readWord() {
      console.warn("Tokenizer#readWord() will be removed, use #readIdentifier instead");
      return this.readIdentifier();
    }
    readIdentifier() {
      this.skipBlank();
      const begin = this.p;
      while (this.peekType() & IDENTIFIER)
        ++this.p;
      return new IdentifierToken(this.input, begin, this.p, this.file);
    }
    readHashes() {
      const hashes = [];
      while (true) {
        const hash = this.readHash();
        if (!hash)
          return hashes;
        hashes.push(hash);
      }
    }
    readHash() {
      this.skipBlank();
      if (this.peek() === ",")
        ++this.p;
      const begin = this.p;
      const name = this.readIdentifier();
      if (!name.size())
        return;
      let value;
      this.skipBlank();
      if (this.peek() === ":") {
        ++this.p;
        value = this.readValue();
      }
      return new HashToken(this.input, begin, this.p, name, value, this.file);
    }
    remaining() {
      return this.input.slice(this.p);
    }
    advance(i = 1) {
      this.p += i;
    }
    end() {
      return this.p >= this.N;
    }
    readTo(end) {
      while (this.p < this.N) {
        ++this.p;
        if (this.rmatch(end))
          return this.p;
      }
      return -1;
    }
    readValue() {
      const value = this.readQuoted() || this.readRange();
      if (value)
        return value;
      if (this.peek() === "[") {
        this.p++;
        const prop = this.readQuoted();
        if (!prop)
          return;
        if (this.peek() !== "]")
          return;
        this.p++;
        return new PropertyAccessToken(prop, [], this.p);
      }
      const variable = this.readIdentifier();
      if (!variable.size())
        return;
      let isNumber = variable.isNumber(true);
      const props = [];
      while (true) {
        if (this.peek() === "[") {
          isNumber = false;
          this.p++;
          const prop = this.readValue() || new IdentifierToken(this.input, this.p, this.p, this.file);
          this.readTo("]");
          props.push(prop);
        } else if (this.peek() === "." && this.peek(1) !== ".") {
          this.p++;
          const prop = this.readIdentifier();
          if (!prop.size())
            break;
          if (!prop.isNumber())
            isNumber = false;
          props.push(prop);
        } else
          break;
      }
      if (!props.length && literalValues.hasOwnProperty(variable.content)) {
        return new LiteralToken(this.input, variable.begin, variable.end, this.file);
      }
      if (isNumber)
        return new NumberToken(variable, props[0]);
      return new PropertyAccessToken(variable, props, this.p);
    }
    readRange() {
      this.skipBlank();
      const begin = this.p;
      if (this.peek() !== "(")
        return;
      ++this.p;
      const lhs = this.readValueOrThrow();
      this.p += 2;
      const rhs = this.readValueOrThrow();
      ++this.p;
      return new RangeToken(this.input, begin, this.p, lhs, rhs, this.file);
    }
    readValueOrThrow() {
      const value = this.readValue();
      assert(value, () => `unexpected token ${this.snapshot()}, value expected`);
      return value;
    }
    readQuoted() {
      this.skipBlank();
      const begin = this.p;
      if (!(this.peekType() & QUOTE))
        return;
      ++this.p;
      let escaped = false;
      while (this.p < this.N) {
        ++this.p;
        if (this.input[this.p - 1] === this.input[begin] && !escaped)
          break;
        if (escaped)
          escaped = false;
        else if (this.input[this.p - 1] === "\\")
          escaped = true;
      }
      return new QuotedToken(this.input, begin, this.p, this.file);
    }
    readFileName() {
      const begin = this.p;
      while (!(this.peekType() & BLANK) && this.peek() !== "," && this.p < this.N)
        this.p++;
      return new IdentifierToken(this.input, begin, this.p, this.file);
    }
    match(word) {
      for (let i = 0; i < word.length; i++) {
        if (word[i] !== this.input[this.p + i])
          return false;
      }
      return true;
    }
    rmatch(pattern) {
      for (let i = 0; i < pattern.length; i++) {
        if (pattern[pattern.length - 1 - i] !== this.input[this.p - 1 - i])
          return false;
      }
      return true;
    }
    peekType(n = 0) {
      return TYPES[this.input.charCodeAt(this.p + n)];
    }
    peek(n = 0) {
      return this.input[this.p + n];
    }
    skipBlank() {
      while (this.peekType() & BLANK)
        ++this.p;
    }
  };
  var TagToken = class extends DelimitedToken {
    constructor(input, begin, end, options, file) {
      const { trimTagLeft, trimTagRight, tagDelimiterLeft, tagDelimiterRight } = options;
      const value = input.slice(begin + tagDelimiterLeft.length, end - tagDelimiterRight.length);
      super(TokenKind.Tag, value, input, begin, end, trimTagLeft, trimTagRight, file);
      const tokenizer = new Tokenizer(this.content, options.operatorsTrie);
      this.name = tokenizer.readIdentifier().getText();
      if (!this.name)
        throw new TokenizationError(`illegal tag syntax`, this);
      tokenizer.skipBlank();
      this.args = tokenizer.remaining();
    }
  };
  var BlockMode;
  (function(BlockMode2) {
    BlockMode2[BlockMode2["OUTPUT"] = 0] = "OUTPUT";
    BlockMode2[BlockMode2["STORE"] = 1] = "STORE";
  })(BlockMode || (BlockMode = {}));
  var monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  var dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday"
  ];
  var monthNamesShort = monthNames.map(abbr);
  var dayNamesShort = dayNames.map(abbr);
  var suffixes = {
    1: "st",
    2: "nd",
    3: "rd",
    "default": "th"
  };
  function abbr(str) {
    return str.slice(0, 3);
  }
  function daysInMonth(d) {
    const feb = isLeapYear(d) ? 29 : 28;
    return [31, feb, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  }
  function getDayOfYear(d) {
    let num = 0;
    for (let i = 0; i < d.getMonth(); ++i) {
      num += daysInMonth(d)[i];
    }
    return num + d.getDate();
  }
  function getWeekOfYear(d, startDay) {
    const now = getDayOfYear(d) + (startDay - d.getDay());
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const then = 7 - jan1.getDay() + startDay;
    return String(Math.floor((now - then) / 7) + 1);
  }
  function isLeapYear(d) {
    const year = d.getFullYear();
    return !!((year & 3) === 0 && (year % 100 || year % 400 === 0 && year));
  }
  function getSuffix(d) {
    const str = d.getDate().toString();
    const index = parseInt(str.slice(-1));
    return suffixes[index] || suffixes["default"];
  }
  function century(d) {
    return parseInt(d.getFullYear().toString().substring(0, 2), 10);
  }
  var formatCodes = {
    a: (d) => dayNamesShort[d.getDay()],
    A: (d) => dayNames[d.getDay()],
    b: (d) => monthNamesShort[d.getMonth()],
    B: (d) => monthNames[d.getMonth()],
    c: (d) => d.toLocaleString(),
    C: (d) => century(d),
    d: (d) => d.getDate(),
    e: (d) => d.getDate(),
    H: (d) => d.getHours(),
    I: (d) => String(d.getHours() % 12 || 12),
    j: (d) => getDayOfYear(d),
    k: (d) => d.getHours(),
    l: (d) => String(d.getHours() % 12 || 12),
    L: (d) => d.getMilliseconds(),
    m: (d) => d.getMonth() + 1,
    M: (d) => d.getMinutes(),
    N: (d, opts) => {
      const width = Number(opts.width) || 9;
      const str = String(d.getMilliseconds()).substr(0, width);
      return padEnd(str, width, "0");
    },
    p: (d) => d.getHours() < 12 ? "AM" : "PM",
    P: (d) => d.getHours() < 12 ? "am" : "pm",
    q: (d) => getSuffix(d),
    s: (d) => Math.round(d.valueOf() / 1e3),
    S: (d) => d.getSeconds(),
    u: (d) => d.getDay() || 7,
    U: (d) => getWeekOfYear(d, 0),
    w: (d) => d.getDay(),
    W: (d) => getWeekOfYear(d, 1),
    x: (d) => d.toLocaleDateString(),
    X: (d) => d.toLocaleTimeString(),
    y: (d) => d.getFullYear().toString().substring(2, 4),
    Y: (d) => d.getFullYear(),
    z: (d, opts) => {
      const nOffset = Math.abs(d.getTimezoneOffset());
      const h = Math.floor(nOffset / 60);
      const m = nOffset % 60;
      return (d.getTimezoneOffset() > 0 ? "-" : "+") + padStart(h, 2, "0") + (opts.flags[":"] ? ":" : "") + padStart(m, 2, "0");
    },
    "t": () => "	",
    "n": () => "\n",
    "%": () => "%"
  };
  formatCodes.h = formatCodes.b;
  var hostTimezoneOffset = new Date().getTimezoneOffset();

  // node_modules/@bookshop/hugo-engine/lib/translateTextTemplate.js
  var tokens = {
    ENTER_COMMENT: `\\*/}}`,
    EXIT_COMMENT: `{{/\\*`,
    END: `{{ end }}`,
    BEGIN: `{{ (if)`,
    BEGIN_SCOPED: `{{ (range|with|define|block|template)`,
    LOOP: `{{ range  () }}`,
    INDEX_LOOP: `{{ range  (\\$.+), \\$.+ := () }}`,
    ASSIGN: `{{ (\\$\\S+)  :=  () }}`,
    REASSIGN: `{{ (\\$\\S+)  =  () }}`,
    WITH: `{{ with  () }}`,
    BOOKSHOP: `{{ partial  "bookshop"  \\( slice "()" () \\) }}`,
    BOOKSHOP_VAR: `{{ partial  "bookshop"  \\( slice (\\S+) () \\) }}`,
    BOOKSHOP_SCOPED: `{{ partial  "bookshop"  \\(? \\. \\)? }}`
  };
  var TOKENS3 = {};
  Object.entries(tokens).forEach(([name, r]) => {
    TOKENS3[name] = new RegExp(r.replace(/\(\)/g, "([\\S\\s]+?)").replace(/  /g, "[\\n\\r\\s]+").replace(/ /g, "[\\n\\r\\s]*"));
  });
  var rewriteTag = function(token, src, state, liveMarkup) {
    let raw = token.getText();
    let outputToken = {
      text: raw
    };
    if (TOKENS3.ENTER_COMMENT.test(raw)) {
      state.inComment = true;
    }
    if (TOKENS3.EXIT_COMMENT.test(raw)) {
      state.inComment = false;
      return outputToken;
    }
    if (state.inComment) {
      return outputToken;
    }
    if (token.kind !== 8)
      return outputToken;
    if (TOKENS3.END.test(raw)) {
      state.endTags.push(outputToken);
      return outputToken;
    }
    if (TOKENS3.BEGIN.test(raw)) {
      state.endTags.pop();
    }
    if (TOKENS3.BEGIN_SCOPED.test(raw)) {
      outputToken.text = `${outputToken.text}{{ \`<!--bookshop-live stack-->\` | safeHTML }}`;
      let matchingEnd = state.endTags.pop();
      matchingEnd.text = `{{ \`<!--bookshop-live unstack-->\` | safeHTML }}${matchingEnd.text}`;
    }
    if (liveMarkup && TOKENS3.INDEX_LOOP.test(raw)) {
      let [, index_variable, iterator] = raw.match(TOKENS3.INDEX_LOOP);
      const r = required_wrapper_hugo_func(iterator);
      outputToken.text = [
        `${outputToken.text}`,
        `{{${r[0]} (printf \`<!--bookshop-live context(.: (index (${tidy(iterator)}) %v))-->\` (jsonify ${index_variable}))${r[1]} | safeHTML }}`
      ].join("");
    } else if (liveMarkup && TOKENS3.LOOP.test(raw)) {
      let [, iterator] = raw.match(TOKENS3.LOOP);
      const r = required_wrapper_hugo_func(iterator);
      outputToken.text = [
        `{{ $bookshop__live__iterator__keys := (slice) }}`,
        `{{ range $i, $e := (${tidy(iterator)}) }}{{ $bookshop__live__iterator__keys = $bookshop__live__iterator__keys | append $i }}{{ end }}`,
        `{{ $bookshop__live__iterator := 0 }}`,
        `${outputToken.text}`,
        `{{ $bookshop__live__iterator__key := (index ($bookshop__live__iterator__keys) $bookshop__live__iterator) }}`,
        `{{${r[0]} (printf \`<!--bookshop-live context(.: (index (${tidy(iterator)}) %v))-->\` (jsonify $bookshop__live__iterator__key))${r[1]} | safeHTML }}`,
        `{{ $bookshop__live__iterator = (add $bookshop__live__iterator 1) }}`
      ].join("");
    } else if (liveMarkup && TOKENS3.ASSIGN.test(raw)) {
      let [, identifier, value] = raw.match(TOKENS3.ASSIGN);
      const r = required_wrapper_hugo_func(value);
      outputToken.text = `${outputToken.text}{{${r[0]} \`<!--bookshop-live context(${identifier}: (${tidy(value)}))-->\`${r[1]} | safeHTML }}`;
    } else if (liveMarkup && TOKENS3.REASSIGN.test(raw)) {
      let [, identifier, value] = raw.match(TOKENS3.REASSIGN);
      const r = required_wrapper_hugo_func(value);
      outputToken.text = `${outputToken.text}{{${r[0]} \`<!--bookshop-live reassign(${identifier}: (${tidy(value)}))-->\`${r[1]} | safeHTML }}`;
    } else if (liveMarkup && TOKENS3.WITH.test(raw)) {
      let [, value] = raw.match(TOKENS3.WITH);
      const r = required_wrapper_hugo_func(value);
      outputToken.text = `${outputToken.text}{{${r[0]} \`<!--bookshop-live context(.: (${tidy(value)}))-->\`${r[1]} | safeHTML }}`;
    } else if (liveMarkup && TOKENS3.BOOKSHOP.test(raw)) {
      let [, name, params] = raw.match(TOKENS3.BOOKSHOP);
      const r = required_wrapper_hugo_func(params);
      outputToken.text = `{{${r[0]} \`<!--bookshop-live name(${name}) params(.: (${tidy(params)}))-->\`${r[1]} | safeHTML }}${outputToken.text}{{ \`<!--bookshop-live end-->\` | safeHTML }}`;
    } else if (liveMarkup && TOKENS3.BOOKSHOP_SCOPED.test(raw)) {
      outputToken.text = [
        `{{ if reflect.IsSlice . }}{{ (printf \`<!--bookshop-live name(%s) params(.: .)-->\` (index . 0)) | safeHTML }}`,
        `{{- else if reflect.IsMap . -}}{{ (printf \`<!--bookshop-live name(%s) params(.: .)-->\` ._bookshop_name) | safeHTML }}{{ end }}`,
        `${outputToken.text}`,
        `{{ \`<!--bookshop-live end-->\` | safeHTML }}`
      ].join("");
    } else if (liveMarkup && TOKENS3.BOOKSHOP_VAR.test(raw)) {
      let [, variable, params] = raw.match(TOKENS3.BOOKSHOP_VAR);
      const r = required_wrapper_hugo_func(params);
      outputToken.text = `{{${r[0]} (printf \`<!--bookshop-live name(%s) params(.: (${tidy(params)}))-->\`${r[1]} (${variable})) | safeHTML }}${outputToken.text}{{ \`<!--bookshop-live end-->\` | safeHTML }}`;
    }
    return outputToken;
  };
  var tidy = (val) => val.replace(/[\r\n]/g, " ").replace(/`/g, "BKSH_BACKTICK");
  var required_wrapper_hugo_func = (val) => /`/.test(val) ? [` replace`, ` "BKSH_BACKTICK" "\`"`] : [``, ``];
  function translateTextTemplate_default(text, opts) {
    opts = {
      liveMarkup: true,
      ...opts
    };
    if (!/bookshop/.test(text)) {
      return text;
    }
    const tokenizer = new Tokenizer(text.toString());
    const tokens2 = tokenizer.readTopLevelTokens();
    const output = [];
    const state = {
      endTags: [],
      inComment: false
    };
    tokens2.reverse().forEach((tag) => {
      output.unshift(rewriteTag(tag, text, state, opts.liveMarkup));
    });
    return output.map((t) => t.text).join("");
  }

  // node_modules/@bookshop/hugo-engine/lib/hugoIdentifierParser.js
  var TOKENS4 = {
    DELIM: /"|'|`/,
    ESCAPE: /\\/,
    SPACE: /\s|\r|\n/,
    INSCOPE: /\(/,
    OUTSCOPE: /\)/,
    SCOPE: /\./
  };
  var IdentifierParser = class {
    constructor(input) {
      this.input = input;
      this.stream = [];
      this.state = `START`;
      this.deps = {};
      this.output = this.input;
    }
    tryShortCircuit() {
      const indexDotFunc = /^\s*\(\s*index\s+(?:\(\s*\.\s*\)|\.)\s+(\d+)\s*\)\s*$/;
      if (indexDotFunc.test(this.input)) {
        const [, index] = this.input.match(indexDotFunc);
        return `${index}`;
      }
      const indexFunc = /^\s*\(\s*index\s+\(?\.?(.+?)\)?\s+(\d+)\s*\)\s*$/;
      if (indexFunc.test(this.input)) {
        const [, variable, index] = this.input.match(indexFunc);
        return `${variable}.${index}`;
      }
      if (/^\s*\./.test(this.input)) {
        return this.input.replace(/^\s*\.([^\.\s])/, "$1");
      }
      return null;
    }
    build() {
      let transformedStr = this.tryShortCircuit();
      if (transformedStr)
        return transformedStr;
      this.stream = this.input?.split?.("") ?? [];
      while (this.stream.length && this.state !== `BREAK`) {
        this.process(this.stream.shift());
      }
      this.process(" ");
      return this.output;
    }
    process(t) {
      switch (this.state) {
        case `START`:
          return this.processSTART(t);
        case `FUNC`:
          return this.processFUNC(t);
        case `DICT_IDENT`:
          return this.processDICT_IDENT(t);
        case `DICT_VALUE`:
          return this.processDICT_VALUE(t);
        case `SLICE`:
          return this.processSLICE(t);
      }
    }
    processSTART(t) {
      if (TOKENS4.SPACE.test(t)) {
        return;
      }
      ;
      if (!TOKENS4.INSCOPE.test(t)) {
        this.state = `BREAK`;
        return;
      }
      ;
      this.state = `FUNC`;
    }
    processFUNC(t) {
      if (TOKENS4.SPACE.test(t) && !this.deps.started) {
        return;
      }
      ;
      this.deps.func = this.deps.func || "";
      this.deps.started = true;
      if (TOKENS4.SPACE.test(t)) {
        switch (this.deps.func) {
          case "dict":
            this.state = `DICT_IDENT`;
            this.output = {};
            this.deps = {};
            return;
          case "slice":
            this.state = `SLICE`;
            this.output = [];
            this.deps = {};
            return;
          default:
            this.state = `BREAK`;
            return;
        }
      }
      this.deps.func += t;
    }
    processDICT_IDENT(t) {
      if (TOKENS4.SPACE.test(t) && !this.deps.started) {
        return;
      }
      ;
      this.deps.identifier = this.deps.identifier || "";
      this.deps.started = true;
      if (TOKENS4.DELIM.test(t) && !this.deps.delim) {
        return this.deps.delim = new RegExp(t);
      }
      if (TOKENS4.OUTSCOPE.test(t)) {
        if (this.deps.identifier.length) {
          throw new Error(`Tried to parse a bad dict: ${this.input}`);
        }
        return this.state = "BREAK";
      }
      if (!this.deps.delim) {
        throw new Error(`Tried to parse a bad dict: ${this.input}`);
      }
      if (this.deps.escape) {
        this.deps.identifier += t;
        this.deps.escape = false;
        return;
      }
      if (this.deps.delim && this.deps.delim.test(t)) {
        this.state = "DICT_VALUE";
        this.deps = { identifier: this.deps.identifier };
        return;
      }
      if (TOKENS4.ESCAPE.test(t)) {
        return this.deps.escape = true;
      }
      this.deps.identifier += t;
      this.deps.escape = false;
    }
    processDICT_VALUE(t) {
      if (TOKENS4.SPACE.test(t) && !this.deps.started) {
        return;
      }
      ;
      this.deps.value = this.deps.value || "";
      this.deps.started = true;
      if (this.deps.escape) {
        this.deps.value += t;
        this.deps.escape = false;
        return;
      }
      if (TOKENS4.ESCAPE.test(t)) {
        this.deps.escape = true;
        return;
      }
      this.deps.value += t;
      if (!this.deps.delim) {
        if (TOKENS4.DELIM.test(t)) {
          return this.deps.delim = new RegExp(t);
        }
        if (TOKENS4.INSCOPE.test(t)) {
          return this.deps.delim = TOKENS4.OUTSCOPE;
        }
        this.deps.delim = TOKENS4.SPACE;
        if (!TOKENS4.SPACE.test(t)) {
          return;
        }
      }
      if (this.deps.delimDepth && this.deps.delim.test(t)) {
        return this.deps.delimDepth -= 1;
      }
      if (!this.deps.delimDepth && this.deps.delim !== TOKENS4.OUTSCOPE && TOKENS4.OUTSCOPE.test(t)) {
        if (this.deps.delim !== TOKENS4.OUTSCOPE)
          this.deps.value = this.deps.value.replace(/.$/, "");
        this.output[this.deps.identifier] = new IdentifierParser(this.deps.value).build();
        this.state = "BREAK";
        this.deps = {};
        return;
      }
      if (this.deps.delim.test(t)) {
        if (this.deps.delim === TOKENS4.SPACE)
          this.deps.value = this.deps.value.replace(/.$/, "");
        this.output[this.deps.identifier] = new IdentifierParser(this.deps.value).build();
        this.state = "DICT_IDENT";
        this.deps = {};
        return;
      }
      if (this.deps.delim === TOKENS4.OUTSCOPE && TOKENS4.INSCOPE.test(t)) {
        this.deps.delimDepth = this.deps.delimDepth || 0;
        this.deps.delimDepth += 1;
      }
    }
    processSLICE(t) {
      if (TOKENS4.SPACE.test(t) && !this.deps.started) {
        return;
      }
      ;
      this.deps.value = this.deps.value || "";
      this.deps.started = true;
      if (this.deps.escape) {
        this.deps.value += t;
        this.deps.escape = false;
        return;
      }
      if (TOKENS4.ESCAPE.test(t)) {
        this.deps.escape = true;
        return;
      }
      this.deps.value += t;
      if (!this.deps.delim) {
        if (TOKENS4.DELIM.test(t)) {
          return this.deps.delim = new RegExp(t);
        }
        if (TOKENS4.INSCOPE.test(t)) {
          return this.deps.delim = TOKENS4.OUTSCOPE;
        }
        this.deps.delim = TOKENS4.SPACE;
        if (!TOKENS4.SPACE.test(t)) {
          return;
        }
      }
      if (this.deps.delimDepth && this.deps.delim.test(t)) {
        return this.deps.delimDepth -= 1;
      }
      if (!this.deps.delimDepth && TOKENS4.OUTSCOPE.test(t)) {
        this.deps.value = this.deps.value.replace(/.$/, "");
        this.output.push(new IdentifierParser(this.deps.value).build());
        this.state = "BREAK";
        this.deps = {};
        return;
      }
      if (this.deps.delim.test(t)) {
        if (this.deps.delim === TOKENS4.SPACE)
          this.deps.value = this.deps.value.replace(/.$/, "");
        this.output.push(new IdentifierParser(this.deps.value).build());
        this.deps = {};
        return;
      }
      if (this.deps.delim === TOKENS4.OUTSCOPE && TOKENS4.INSCOPE.test(t)) {
        this.deps.delimDepth = this.deps.delimDepth || 0;
        this.deps.delimDepth += 1;
      }
    }
  };

  // node_modules/@bookshop/hugo-engine/lib/engine.js
  var sleep2 = (ms = 0) => {
    return new Promise((r) => setTimeout(r, ms));
  };
  var dig2 = (obj, path) => {
    if (typeof path === "string")
      path = path.replace(/\[(\d+)]/g, ".$1").split(".");
    obj = obj[path.shift()];
    if (obj && path.length)
      return dig2(obj, path);
    return obj;
  };
  var mapHugoVariablesToParams = (obj, path) => {
    let resolved = {};
    for (let [k, v] of Object.entries(obj)) {
      if (k.startsWith("$")) {
        const remapped = `__bksh_${k.substring(1)}`;
        obj[remapped] = v;
        resolved[k] = `${path}.${remapped}`;
      } else {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          resolved = { ...resolved, ...mapHugoVariablesToParams(v, `${path}.${k}`) };
        }
      }
    }
    return resolved;
  };
  var Engine = class {
    constructor(options) {
      options = {
        name: "Hugo",
        files: {},
        ...options
      };
      this.key = "hugo";
      this.name = options.name;
      this.files = options.files;
      this.origin = (typeof document === "undefined" ? "" : document.currentScript?.src) || `/bookshop.js`;
      this.synthetic = options.synthetic ?? false;
      if (!this.synthetic) {
        this.initializeHugo();
      }
    }
    async initializeHugo() {
      const templates = {
        "layouts/partials/bookshop.html": (await Promise.resolve().then(() => (init_bookshop(), bookshop_exports))).default,
        "layouts/partials/bookshop_scss.html": (await Promise.resolve().then(() => (init_bookshop_scss(), bookshop_scss_exports))).default,
        "layouts/partials/bookshop_partial.html": (await Promise.resolve().then(() => (init_bookshop_partial(), bookshop_partial_exports))).default,
        "layouts/partials/bookshop_component_browser.html": (await Promise.resolve().then(() => (init_bookshop_component_browser(), bookshop_component_browser_exports))).default,
        "layouts/partials/bookshop_bindings.html": (await Promise.resolve().then(() => (init_bookshop_bindings(), bookshop_bindings_exports))).default,
        "layouts/partials/_bookshop/helpers/component.html": (await Promise.resolve().then(() => (init_component(), component_exports))).default,
        "layouts/partials/_bookshop/helpers/component_key.html": (await Promise.resolve().then(() => (init_component_key(), component_key_exports))).default,
        "layouts/partials/_bookshop/helpers/flat_component_key.html": (await Promise.resolve().then(() => (init_flat_component_key(), flat_component_key_exports))).default,
        "layouts/partials/_bookshop/helpers/partial.html": (await Promise.resolve().then(() => (init_partial(), partial_exports))).default,
        "layouts/partials/_bookshop/helpers/partial_key.html": (await Promise.resolve().then(() => (init_partial_key(), partial_key_exports))).default,
        "layouts/partials/_bookshop/errors/bad_bookshop_tag.html": (await Promise.resolve().then(() => (init_bad_bookshop_tag(), bad_bookshop_tag_exports))).default,
        "layouts/partials/_bookshop/errors/err.html": (await Promise.resolve().then(() => (init_err(), err_exports))).default
      };
      templates["config.toml"] = "params.env_bookshop_live = true";
      if (hugo_renderer_wasm_default?.constructor === Uint8Array) {
        await this.initializeInlineHugo();
      } else {
        await this.initializeLocalCompressedHugo();
      }
      const mappedFiles = {};
      for (const file of Object.entries(this.files)) {
        mappedFiles[`layouts/partials/bookshop/${file[0]}`] = translateTextTemplate_default(file[1], {});
      }
      const componentSuccess = window["writeHugoFiles"](JSON.stringify(mappedFiles));
      const templateSuccess = window["writeHugoFiles"](JSON.stringify(templates));
      window.writeHugoFiles(JSON.stringify({
        "layouts/index.html": "Uninitialized Layout",
        "content/_index.md": '{ \u201Dinitialized": false }\n'
      }));
    }
    async initializeLocalCompressedHugo() {
      try {
        let prefetched = {};
        if (typeof window !== "undefined" && window?.CloudCannon && window?.CloudCannon?.prefetchedFiles) {
          prefetched = await window.CloudCannon.prefetchedFiles?.();
          this.availablePrefetchKeys = Object.keys(prefetched);
        }
        const go = new Go();
        const compressedWasmOrigin = this.origin.replace(/\/[^\.\/]+\.(min\.)?js/, hugo_renderer_wasm_default.replace(/^\./, ""));
        const compressedWasmPath = new URL(compressedWasmOrigin).pathname;
        let compressedBuffer;
        if (prefetched[compressedWasmPath]) {
          compressedBuffer = await prefetched[compressedWasmPath]?.arrayBuffer();
          this.loadedFrom = "prefetch";
        } else {
          const compressedResponse = await fetch(compressedWasmOrigin);
          compressedBuffer = await compressedResponse.arrayBuffer();
          this.loadedFrom = "network";
        }
        const renderer = gunzipSync(new Uint8Array(compressedBuffer));
        const isWasm = [...renderer.slice(0, 4)].map((g) => g.toString(16).padStart(2, "0")).join("") === "0061736d";
        if (!isWasm)
          throw "Not WASM";
        const compressedResult = await WebAssembly.instantiate(renderer, go.importObject);
        go.run(compressedResult.instance);
      } catch (e) {
        console.error("Couldn't load the local compressed Hugo WASM");
        console.error(e);
      }
    }
    async initializeInlineHugo() {
      const go = new Go();
      const buffer = hugo_renderer_wasm_default.buffer;
      const renderer = gunzipSync(new Uint8Array(buffer));
      const result = await WebAssembly.instantiate(renderer, go.importObject);
      go.run(result.instance);
    }
    getSharedKey(name) {
      return `shared/hugo/${name}.hugo.html`;
    }
    getShared(name) {
      const key = this.getSharedKey(name);
      return this.files?.[key];
    }
    getComponentKey(name) {
      const base = name.split("/").reverse()[0];
      return `components/${name}/${base}.hugo.html`;
    }
    getFlatComponentKey(name) {
      return `components/${name}.hugo.html`;
    }
    getComponent(name) {
      const key = this.getComponentKey(name);
      const flatKey = this.getFlatComponentKey(name);
      return this.files?.[key] ?? this.files?.[flatKey];
    }
    hasComponent(name) {
      const key = this.getComponentKey(name);
      const flatKey = this.getFlatComponentKey(name);
      return !!(this.files?.[key] ?? this.files?.[flatKey]);
    }
    hasShared(name) {
      const key = this.getSharedKey(name);
      return !!this.files?.[key];
    }
    resolveComponentType(name) {
      if (this.hasComponent(name))
        return "component";
      if (this.hasShared(name))
        return "shared";
      return false;
    }
    transformData(data) {
      return {
        Params: data
      };
    }
    async storeMeta(meta = {}) {
      while (!window.writeHugoFiles) {
        await sleep2(100);
      }
      ;
      window.writeHugoFiles(JSON.stringify({
        "config.toml": [
          meta.baseurl ? `baseURL = ${meta.baseurl}` : "",
          meta.copyright ? `copyright = ${meta.copyright}` : "",
          meta.title ? `title = ${meta.title}` : "",
          "params.env_bookshop_live = true"
        ].join("\n")
      }));
      const err2 = window.initHugoConfig();
      if (err2) {
        console.error(err2);
      }
    }
    async storeInfo(info = {}) {
      while (!window.writeHugoFiles) {
        await sleep2(100);
      }
      ;
      const data = info?.data;
      if (!data || typeof data !== "object")
        return;
      const files2 = {};
      for (const [file, contents] of Object.entries(data)) {
        files2[`data/${file}.json`] = JSON.stringify(contents);
      }
      window.writeHugoFiles(JSON.stringify(files2));
    }
    async componentQuack(error_string = "", log_messages = []) {
      try {
        const component_regex = /execute of template failed: template: ([^:]+):\d/ig;
        let file_stack = [...error_string.matchAll(component_regex)].map(([, file]) => `layouts/${file}`);
        if (file_stack.length) {
          const deepest_errored_component = file_stack[file_stack.length - 1];
          const error_chunks = error_string.split("execute of template failed:");
          const error_msg = error_chunks[error_chunks.length - 1] ?? "template error";
          window.writeHugoFiles(JSON.stringify({
            [deepest_errored_component]: [
              `<div style="padding: 10px; background-color: lightcoral; color: black; font-weight: bold;">`,
              `Failed to render ${deepest_errored_component}. <br/>`,
              `<pre style="margin-top: 10px; background-color: lightcoral; border: solid 1px black; white-space: pre-line;">`,
              `<code style="font-family: monospace; color: black;">${error_msg.replace(/</, "&lt;")}</code></pre>`,
              `</div>`
            ].join("\n")
          }));
          return deepest_errored_component;
        }
        const error_logs = log_messages.filter((log) => log.startsWith("ERROR")).join("\n");
        const missing_regex = /Component "([^"]+)" does not exist/ig;
        file_stack = [...error_logs.matchAll(missing_regex)].map(([, file]) => {
          let filename = file.split("/").pop();
          return `layouts/partials/bookshop/components/${file}/${filename}.hugo.html`;
        });
        if (file_stack.length) {
          const deepest_errored_component = file_stack[file_stack.length - 1];
          window.writeHugoFiles(JSON.stringify({
            [deepest_errored_component]: [
              `<div class="bookshop_error" style="padding: 10px; background-color: lightcoral; color: black; font-weight: bold;">`,
              `Failed to find component ${deepest_errored_component}`,
              `</div>`
            ].join("\n")
          }));
          return deepest_errored_component;
        }
      } catch (e) {
        console.error(`ComponentQuack failed to patch things up: ${e}`);
        return null;
      }
    }
    async render(target, name, props, globals, logger) {
      while (!window.buildHugo) {
        logger?.log?.(`Waiting for the Hugo WASM to be available...`);
        await sleep2(100);
      }
      ;
      let writeFiles = {};
      if (this.hasComponent(name)) {
        writeFiles["layouts/index.html"] = `{{ partial "bookshop" (slice "${name}" .Params.component) }}`;
      } else if (this.hasShared(name)) {
        writeFiles["layouts/index.html"] = `{{ partial "bookshop_partial" (slice "${name}" .Params.component) }}`;
      } else {
        console.warn(`[hugo-engine] No component found for ${name}`);
        return "";
      }
      logger?.log?.(`Going to render ${name}, with layout:`);
      logger?.log?.(writeFiles["layouts/index.html"]);
      if (!globals || typeof globals !== "object")
        globals = {};
      props = {
        ...globals,
        ...props,
        env_bookshop_live: true
      };
      if (props["."])
        props = props["."];
      writeFiles["content/_index.md"] = JSON.stringify({
        component: props
      }, null, 2) + "\n";
      window.writeHugoFiles(JSON.stringify(writeFiles));
      window.hugo_wasm_logging = [];
      let render_attempts = 1;
      let buildError = window.buildHugo();
      while (buildError && render_attempts < 5) {
        if (this.componentQuack(buildError, window.hugo_wasm_logging) === null) {
          break;
        }
        window.hugo_wasm_logging = [];
        buildError = window.buildHugo();
        render_attempts += 1;
      }
      if (buildError) {
        console.error(buildError);
        return;
      }
      const output = window.readHugoFiles(JSON.stringify([
        "public/index.html"
      ]));
      target.innerHTML = output["public/index.html"];
      return;
    }
    async eval(str, props = [{}], logger) {
      if (!this.synthetic) {
        while (!window.buildHugo)
          await sleep2(10);
      }
      let props_obj = props.reduce((a, b) => {
        return { ...a, ...b };
      });
      let full_props = props_obj;
      str = str.trim();
      if (/^".*"$|^`.*`$|^\d+(\.\d+)?$|^true$|^false$/.test(str)) {
        logger?.log?.(`Unwrapping the string ${str}`);
        try {
          if (/^`.*`$/.test(str)) {
            return JSON.parse(str.replace(/^`|`$/g, '"'));
          }
          return JSON.parse(str);
        } catch (e) {
          logger?.log?.(`Was not valid JSON for some reason. Moving on...`);
        }
      }
      if (/^\$/.test(str)) {
        logger?.log?.(`Trying to short circuit to return a variable`);
        if (props_obj[str])
          return props_obj[str];
      }
      if (props_obj["."]) {
        logger?.log?.(`Nesting the props object into its dot scope`);
        props_obj = props_obj["."];
      }
      if (str === ".") {
        logger?.log?.(`Short circuiting dot notation to return the scope`);
        return props_obj;
      }
      let normalized = this.normalize(str);
      if (typeof normalized === "object") {
        logger?.log?.(`Digging into the object ${JSON.stringify(normalized)}`);
        const process = async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "string") {
              logger?.log?.(`Evaluating the inner ${k}: ${v}`);
              obj[k] = await this.eval(v, [props_obj], logger?.nested?.());
            } else if (typeof v === "object") {
              logger?.log?.(`Processing the inner object ${k}`);
              process(v);
            }
          }
        };
        await process(normalized);
        return normalized;
      }
      if (/^\w+(\.\w+)*$/.test(normalized)) {
        logger?.log?.(`Trying to short circuit to return the dot notation ${normalized}`);
        const result = dig2(props_obj, normalized);
        if (result !== void 0)
          return result;
      }
      str = str.replace(/(.*)\.(\d+)$/, (_, obj, index) => {
        return `index (${obj}) ${index}`;
      });
      const variable_pairs = mapHugoVariablesToParams(full_props, ".Params.full_props");
      const variable_decl = Object.entries(variable_pairs).map(([k, v]) => {
        return `{{ ${k} := ${v} }}`;
      }).join("");
      const assignments = Object.entries(props_obj).filter(([key]) => key.startsWith("$")).map(([key, value]) => {
        if (Array.isArray(value)) {
          return `{{ ${key} := index ( \`{"a": ${JSON.stringify(value)}}\` | transform.Unmarshal ) "a" }}`;
        } else if (typeof value === "object") {
          return `{{ ${key} := \`${JSON.stringify(value)}\` | transform.Unmarshal }}`;
        } else {
          return `{{ ${key} := ${JSON.stringify(value)} }}`;
        }
      }).join("");
      const eval_str = `${variable_decl}{{ with .Params.props }}${assignments}{{ jsonify (${str}) }}{{ end }}`;
      if (this.synthetic) {
        return null;
      }
      window.writeHugoFiles(JSON.stringify({
        "layouts/index.html": eval_str,
        "content/_index.md": JSON.stringify({ props: props_obj, full_props }, null, 2)
      }));
      const buildError = window.buildHugo();
      if (buildError) {
        console.warn(buildError);
        return;
      }
      const output = window.readHugoFiles(JSON.stringify([
        "public/index.html"
      ]))["public/index.html"];
      try {
        return JSON.parse(output);
      } catch (e) {
        logger?.log?.(`Error evaluating \`${str}\` in the Hugo engine`);
        logger?.log?.(output);
        return null;
      }
    }
    normalize(str) {
      return new IdentifierParser(str).build();
    }
    loader() {
    }
  };

  // component-library/components/blog-feed/blog-feed.hugo.html
  var blog_feed_hugo_default = '{{ if site.Params.env_bookshop_live }}\n<section class="block bg-gray">\n    <div class="wrapper-lg flow">\n        <h2 class="text-align-center max-width-none">Our Recent Posts</h2>\n        <p class="text-align-center margin-inline-auto">This is just a placeholder to show you what your blog feed will look like. Blog posts cannot be edited here and need to be edited in the blog section of your website.</p>\n        <div class="block-md">\n            <ul class="auto-grid gap-sm max-width-none no-margin no-padding">\n                {{ range seq 3 }}\n                <li class="card">\n                    <div class="accent-line flow">\n                        <a class="card__category" href="#" aria-label="View all posts">Example</a>\n                        <h3 class="card__title h6"><a href="#" class="card__link">Blog Post Title</a></h3>\n                        <p class="card__summary font-size-xs">\n                            Your actual blog posts will be displayed on the page rather than these example cards which cannot be edited here.\n                        </p>\n                    </div>\n                </li>\n                {{ end }}\n            </ul>\n        </div>\n    </div>\n</section>\n{{ else }}\n<section class="block bg-{{ .background_color }}" aria-label="Featured Articles">\n    <div class="wrapper-lg flow">\n        <h2 class="text-align-center max-width-none">{{ .heading }}</h2>\n        <p class="text-align-center margin-inline-auto">{{ .body | markdownify }}</p>\n        <div class="block-md">\n            <ul class="auto-grid gap-sm max-width-none no-margin no-padding">\n                {{ range where site.RegularPages "Section" "blog" | first 3 }}\n                    {{ .Render "blog-card" }}\n                {{- end -}}\n            </ul>\n        </div>\n        <div class="text-align-center">\n            {{ if .button.enabled }}\n              {{ with .button }}\n                  <a class="btn btn--primary" href="{{ .button_url }}" {{ if .open_in_new_tab }}target="_blank"{{ end }}>{{ .button_text }}</a>\n              {{ end }}\n            {{ end }}\n        </div>\n    </div>\n</section>\n{{ end }}';

  // bookshop-import-file:components/blog-feed/blog-feed.hugo.html__bookshop_file__
  var blog_feed_hugo_default2 = blog_feed_hugo_default;

  // component-library/components/careers-feed/careers-feed.hugo.html
  var careers_feed_hugo_default = '{{ if site.Params.env_bookshop_live }}\n<section class="block bg-gray">\n    <div class="wrapper-lg flow">\n        <h2 class="text-align-center max-width-none">Open Positions</h2>\n        <div class="block-md">\n            <ul class="grid-columns-3 gap-sm max-width-none no-margin no-padding">\n                {{ range seq 3 }}\n                <li class="card">\n                    <div class="accent-line flow">\n                        <h3 class="card__title h6"><a href="#" class="card__link">Job Position Title</a></h3>\n                        <p class="card__summary font-size-xs">\n                            Your actual job opening will be displayed on the page rather than these example cards which cannot be edited here.\n                        </p>\n                    </div>\n                </li>\n                {{ end }}\n            </ul>\n        </div>\n    </div>\n</section>\n{{ else }}\n<section class="block bg-{{ .background_color }}" aria-label="Job Openings">\n    <div class="wrapper-lg flow">\n        <h2 class="text-align-center max-width-none">{{ .heading }}</h2>\n        <div class="block-md">\n            <ul class="grid-columns-3 gap-sm max-width-none no-margin no-padding">\n                {{ range where site.RegularPages "Section" "careers" }}\n                    {{ .Render "blog-card" }}\n                {{- end -}}\n            </ul>\n        </div>\n    </div>\n</section>\n{{ end }}';

  // bookshop-import-file:components/careers-feed/careers-feed.hugo.html__bookshop_file__
  var careers_feed_hugo_default2 = careers_feed_hugo_default;

  // component-library/components/columns/columns.hugo.html
  var columns_hugo_default = '<section class="block bg-{{ .background_color }} text-align-{{ .text_align }}" aria-labelledby="{{ .heading | urlize }}">\n	<div class="wrapper-lg">\n		<h2 id="{{ .heading | urlize }}" class="mb-6 max-width-none">{{ .heading }}</h2>\n		<div class="columns gap-md">\n			{{ range .columns }}\n				<div class="col">\n					{{ partial "bookshop" . }}\n				</div>\n		  	{{ end }}\n		</div>\n	</div>\n</section>';

  // bookshop-import-file:components/columns/columns.hugo.html__bookshop_file__
  var columns_hugo_default2 = columns_hugo_default;

  // component-library/components/content/content.hugo.html
  var content_hugo_default = "{{ .body | markdownify }}";

  // bookshop-import-file:components/content/content.hugo.html__bookshop_file__
  var content_hugo_default2 = content_hugo_default;

  // component-library/components/cta/cta.hugo.html
  var cta_hugo_default = '<section class="cta cta--split columns bg-{{ .background_color }}" aria-labelledby="{{ .heading | urlize }}">\n    <div class="cta__content block margin-block-auto col">\n      <div class="accent-line wrapper-sm flow">\n        <h2 class="h1" id="{{ .heading | urlize }}">{{ .heading }}</h2>\n        <p>{{ .body | markdownify }}</p>\n        {{ if .button.enabled }}\n            {{ with .button }}\n                <a class="btn btn--primary" href="{{ .button_url }}" {{ if .open_in_new_tab }}target="_blank"{{ end }}>{{ .button_text }}</a>\n            {{ end }}\n        {{ end }}\n      </div>\n    </div>\n    <div class="cta__image col">\n        <img src="{{ .image.image_url }}" alt="{{ .image.image_alt }}" width="1200" height="800">\n    </div>\n</section>\n  \n  ';

  // bookshop-import-file:components/cta/cta.hugo.html__bookshop_file__
  var cta_hugo_default2 = cta_hugo_default;

  // component-library/components/double-cta/double-cta.hugo.html
  var double_cta_hugo_default = '<section class="cta cta--double block" aria-labelledby="{{ .cta_left.heading | urlize }}">\n    <div class="wrapper-lg columns gap-lg">\n        <div class="accent-line col">\n            <div class="wrapper-sm flow">\n                <h2 id="{{ .cta_left.heading | urlize }}">{{ .cta_left.heading }}</h2>\n                <p>{{ .cta_left.body | markdownify }}</p>\n                {{ if .cta_left.button.enabled }}\n                    {{ with .cta_left.button }}\n                        <a class="btn btn--primary" href="{{ .button_url }}" {{ if .open_in_new_tab }}target="_blank"{{ end }}>{{ .button_text }}</a>\n                    {{ end }}\n                {{ end }}\n            </div>\n        </div>\n        <div class="accent-line col">\n            <div class="wrapper-sm flow">\n                <h2>{{ .cta_right.heading }}</h2>\n                <p>{{ .cta_right.body | markdownify }}</p>\n                {{ if .cta_right.button.enabled }}\n                    {{ with .cta_right.button }}\n                        <a class="btn btn--primary" href="{{ .button_url }}" {{ if .open_in_new_tab }}target="_blank"{{ end }}>{{ .button_text }}</a>\n                    {{ end }}\n                {{ end }}\n            </div>\n        </div>\n    </div>\n</section>\n  ';

  // bookshop-import-file:components/double-cta/double-cta.hugo.html__bookshop_file__
  var double_cta_hugo_default2 = double_cta_hugo_default;

  // component-library/components/hero-simple/hero-simple.hugo.html
  var hero_simple_hugo_default = '<section class="hero--blog block bg-black" aria-labelledby="hero-heading">\n  <div class="wrapper-sm text-align-center flow">\n    <h1 class="max-width-none no-margin" id="hero-heading">{{ .heading }}</h1>\n    <p class="margin-inline-auto">{{ .body | markdownify }}</p>\n  </div>\n</section>';

  // bookshop-import-file:components/hero-simple/hero-simple.hugo.html__bookshop_file__
  var hero_simple_hugo_default2 = hero_simple_hugo_default;

  // component-library/components/hero-split/hero-split.hugo.html
  var hero_split_hugo_default = '<section class="hero hero--split-hero columns gap-md block" aria-labelledby="hero-heading">\n  <div class="hero__content margin-block-auto col block">\n    <div class="accent-line wrapper-sm flow">\n      <h1 class="no-margin" id="hero-heading">{{ .heading }}</h1>\n      <p>{{ .body | markdownify }}</p>\n      {{ if .button.enabled }}\n        {{ with .button }}\n            <a class="btn btn--primary" href="{{ .button_url }}" {{ if .open_in_new_tab }}target="_blank"{{ end }}>{{ .button_text }}</a>\n        {{ end }}\n      {{ end }}\n    </div>\n  </div>\n  <div class="hero__image col">\n    <img class="rounded-image" src="{{ .image.image_url }}" alt="{{ .image.image_alt }}" width="1800" height="600">\n  </div>\n</section>';

  // bookshop-import-file:components/hero-split/hero-split.hugo.html__bookshop_file__
  var hero_split_hugo_default2 = hero_split_hugo_default;

  // component-library/components/hero-two-column/hero-two-column.hugo.html
  var hero_two_column_hugo_default = '<section class="hero--simple block" aria-labelledby="hero-heading">\n  <div class="wrapper-lg columns gap-md">\n    <div class="col margin-block-auto">\n      <div class="accent-line wrapper-sm flow">\n        <h1 class="no-margin" id="hero-heading">{{ .heading }}</h1>\n        <p>{{ .body | markdownify }}</p>\n        {{ if .button.enabled }}\n          {{ with .button }}\n              <a class="btn btn--primary" href="{{ .button_url }}" {{ if .open_in_new_tab }}target="_blank"{{ end }}>{{ .button_text }}</a>\n          {{ end }}\n        {{ end }}\n      </div>\n    </div>\n    <div class="decorative-image col">\n      <img class="decorative-image__image rounded-image" src="{{ .image.image_url }}" alt="{{ .image.image_alt }}" width="1200" height="800">\n      <img class="decorative-image__circles background-circles" src="/uploads/circles-background-square.svg" alt="">\n    </div>\n  </div>\n</section>';

  // bookshop-import-file:components/hero-two-column/hero-two-column.hugo.html__bookshop_file__
  var hero_two_column_hugo_default2 = hero_two_column_hugo_default;

  // component-library/components/hero/hero.hugo.html
  var hero_hugo_default = '<section class="hero block" aria-labelledby="hero-heading">\n    <div class="wrapper-lg columns gap-md">\n        <div class="hero__content col margin-block-auto">\n          <div class="accent-line wrapper-sm flow">\n            <h1 class="no-margin" id="hero-heading">{{ .heading }}</h1>\n            <p>{{ .body | markdownify }}</p>\n            {{ if .button.enabled }}\n              {{ with .button }}\n                  <a class="btn btn--primary" href="{{ .button_url }}" {{ if .open_in_new_tab }}target="_blank"{{ end }}>{{ .button_text }}</a>\n              {{ end }}\n            {{ end }}\n          </div>\n        </div>\n        <div class="hero__image-grid decorative-image col">\n          <div class="hero__image-grid-1 hero__image rounded-image">\n            <img class="animate-slowpulse" src="{{ .image_1.image_url }}" alt="{{ .image_1.image_alt }}" width="1800" height="600">\n          </div>\n          <div class="hero__image-grid-2 hero__image rounded-image">\n            <img class="animate-slowpulse" src="{{ .image_2.image_url }}" alt="{{ .image_2.image_alt }}" width="1800" height="600">\n          </div>\n          <div class="hero__image-grid-3 hero__image rounded-image">\n            <img class="animate-slowpulse" src="{{ .image_3.image_url }}" alt="{{ .image_3.image_alt }}" width="1800" height="600">\n          </div>\n          <img class="decorative-image__circles background-circles" src="/uploads/circles-background.svg" alt="">\n        </div>\n    </div>\n</section>';

  // bookshop-import-file:components/hero/hero.hugo.html__bookshop_file__
  var hero_hugo_default2 = hero_hugo_default;

  // component-library/components/icon-card/icon-card.hugo.html
  var icon_card_hugo_default = '<div class="icon-card flow text-align-{{ .text_align }}">\n    <img class="icon-card__image margin-inline-auto" src="{{ .image.image_url }}" alt="{{ .image.image_url }}">\n    <h3 class="max-width-none">{{ .heading }}</h3>\n    <p>{{ .body | markdownify }}</p>\n</div>';

  // bookshop-import-file:components/icon-card/icon-card.hugo.html__bookshop_file__
  var icon_card_hugo_default2 = icon_card_hugo_default;

  // component-library/components/intro/intro.hugo.html
  var intro_hugo_default = '<section class="block bg-{{ .background_color }} text-align-{{ .text_align }}" aria-labelledby="{{ .heading | urlize }}">\n    <div class="wrapper-sm flow">\n        <h2 class="max-width-none" id="{{ .heading | urlize }}">{{ .heading }}</h2>\n        <p>{{ .body | markdownify }}</p>\n        {{ if .button.enabled }}\n            {{ with .button }}\n                <a class="btn btn--primary" href="{{ .button_url }}" {{ if .open_in_new_tab }}target="_blank"{{ end }}>{{ .button_text }}</a>\n            {{ end }}\n        {{ end }}\n    </div>\n</section>';

  // bookshop-import-file:components/intro/intro.hugo.html__bookshop_file__
  var intro_hugo_default2 = intro_hugo_default;

  // component-library/components/media-text/media-text.hugo.html
  var media_text_hugo_default = '<section class="media-text-block {{ if eq .text_column_position "left" }}media-text-block--text-left{{ else }}media-text-block--text-right{{ end }} block bg-{{ .background_color }}" aria-labelledby="{{ .heading | urlize }}">\n    <div class="wrapper-lg columns gap-md">\n        <div class="media-text-block__content block margin-block-auto col flow">\n            <h2 id="{{ .heading | urlize }}">{{ .heading }}</h2>\n            <p>{{ .body | markdownify }}</p>\n            {{ if .button.enabled }}\n              {{ with .button }}\n                  <a class="btn btn--primary" href="{{ .button_url }}" {{ if .open_in_new_tab }}target="_blank"{{ end }}>{{ .button_text }}</a>\n              {{ end }}\n            {{ end }}\n        </div>\n        <div class="decorative-image col">\n            <img class="decorative-image__image rounded-image" src="{{ .image.image_url }}" alt="{{ .image.image_alt }}" width="600" height="400">\n            {{ if .decorative_image.enabled }}\n                <img class="decorative-image__circles background-circles" src="/uploads/circles-background-square.svg" alt="">\n            {{ end }}\n        </div>\n    </div>\n</section>\n  ';

  // bookshop-import-file:components/media-text/media-text.hugo.html__bookshop_file__
  var media_text_hugo_default2 = media_text_hugo_default;

  // component-library/components/numbers/numbers.hugo.html
  var numbers_hugo_default = '<section class="numbers block bg-{{ .background_color }}" aria-labelledby="{{ .heading | urlize }}">\n	<div class="wrapper-lg">\n		<h2 class="mb-6" id="{{ .heading | urlize }}">{{ .heading }}</h2>\n		<div class="columns gap-lg">\n			{{ range .numbers }}\n				<div class="number col flow">\n					<h3>{{ .heading }}</h3>\n					<p class="fw-500">{{ .body | markdownify }}</p>\n				</div>\n			{{ end }}\n		</div>\n	</div>\n</section>';

  // bookshop-import-file:components/numbers/numbers.hugo.html__bookshop_file__
  var numbers_hugo_default2 = numbers_hugo_default;

  // component-library/components/services-feed/services-feed.hugo.html
  var services_feed_hugo_default = '{{ if site.Params.env_bookshop_live }}\n<section class="block bg-gray">\n    <div class="wrapper-lg flow text-align-center">\n        <h2 class="max-width-none">Our Services</h2>\n        <p class="margin-inline-auto">This is just a placeholder to show you what your services feed will look like. Services cannot be edited here and need to be edited in the Services section of your website.</p>\n        <div class="block-md">\n            <ul class="grid-columns-4 gap-sm max-width-none no-margin no-padding">\n                {{ range seq 3 }}\n                <li class="image-card">\n                    <div class="image-card__image">\n                        <img src="/uploads/home-attic-inspection-1.jpg" alt="">\n                    </div>\n                    <div class="image-card__content">\n                        <h3 class="no-margin"><a href="/services/homeowners/home-energy-audits/" class="card__link">Home Energy Audits</a></h3>\n                        <p class="image-card__job-title text-style-slub"></p>\n                    </div>\n                </li>\n                {{ end }}\n            </ul>\n        </div>\n    </div>\n</section>\n{{ else }}\n<section class="block bg-{{ .background_color }}" aria-labelledby="{{ .heading | urlize }}">\n    <div class="wrapper-lg flow text-align-center">\n        <h2 class="max-width-none" id="{{ .heading | urlize }}">{{ .heading }}</h2>\n        <p class="margin-inline-auto">{{ .body | markdownify }}</p>\n        <div class="block-md">\n            <ul class="grid-columns-4 gap-sm max-width-none no-margin no-padding">\n                {{ if eq .services_feed "Business" }}\n                    {{ range where site.RegularPages "Params.service_type" "business" }}\n                        {{ .Render "image-card" }}\n                    {{ end }}\n                {{ else if eq .services_feed "Homeowners" }}\n                    {{ range where site.RegularPages "Params.service_type" "homeowners" }}\n                        {{ .Render "image-card" }}\n                    {{ end }}\n                {{ end }}\n            </ul>\n        </div>\n    </div>\n</section>\n{{ end }}';

  // bookshop-import-file:components/services-feed/services-feed.hugo.html__bookshop_file__
  var services_feed_hugo_default2 = services_feed_hugo_default;

  // component-library/components/staff-feed/staff-feed.hugo.html
  var staff_feed_hugo_default = '{{ if site.Params.env_bookshop_live }}\n<section class="block bg-gray">\n    <div class="wrapper-lg flow text-align-center">\n        <h2 class="max-width-none">Our Staff</h2>\n        <p class="margin-inline-auto">This is just a placeholder to show you what your staff feed will look like. Staff cannot be edited here and need to be edited in the about section of your website.</p>\n        <div class="block-md">\n            <ul class="grid-columns-3 gap-sm max-width-none no-margin no-padding">\n                {{ range seq 3 }}\n                <li class="image-card">\n                    <div class="image-card__image">\n                        <img src="/uploads/sophia-martinez.jpg" alt="">\n                    </div>\n                    <div class="image-card__content text-align-center">\n                        <h3 class="no-margin"><a href="#" class="card__link">Example Staff Name</a></h3>\n                        <p class="image-card__job-title">Example Job Title</p>\n                    </div>\n                </li>\n                {{ end }}\n            </ul>\n        </div>\n    </div>\n</section>\n{{ else }}\n<section class="block bg-{{ .background_color }}" aria-labelledby="{{ .heading | urlize }}">\n    <div class="wrapper-md flow text-align-center">\n        <h2 class="max-width-none" id="{{ .heading | urlize }}">{{ .heading }}</h2>\n        <p class="margin-inline-auto">{{ .body | markdownify }}</p>\n        <div class="block-md">\n            <ul class="grid-columns-3 gap-sm max-width-none no-margin no-padding">\n                {{ range where site.RegularPages "Section" "about" }}\n                    {{ .Render "image-card" }}\n                {{- end -}}\n            </ul>\n        </div>\n    </div>\n</section>\n{{ end }}';

  // bookshop-import-file:components/staff-feed/staff-feed.hugo.html__bookshop_file__
  var staff_feed_hugo_default2 = staff_feed_hugo_default;

  // component-library/components/testimonial/testimonial.hugo.html
  var testimonial_hugo_default = '<div class="block bg-{{ .background_color }}">\n    <div class="testimonial testimonial--full wrapper-md flow">\n        <div class="testimonial__icon margin-inline-auto icon-xxl icon-fill-primary">\n            <svg width="45" height="41" viewBox="0 0 45 41" fill="none" xmlns="http://www.w3.org/2000/svg">\n            <path d="M0.65 40.15C0.65 37.75 0.65 35.35 0.65 32.95C0.65 30.45 0.65 28 0.65 25.6C0.65 17.9 1.75 11.85 3.95 7.44999C6.15 3.05 10 0.749995 15.5 0.549992L18.35 6.4C15.25 6.69999 13.1 8.19999 11.9 10.9C10.8 13.5 10.25 17.65 10.25 23.35H18.2V40.15H0.65ZM27.05 40.15C27.05 37.75 27.05 35.35 27.05 32.95C27.05 30.45 27.05 28 27.05 25.6C27.05 17.9 28.15 11.85 30.35 7.44999C32.55 3.05 36.4 0.749995 41.9 0.549992L44.75 6.4C41.65 6.69999 39.5 8.19999 38.3 10.9C37.2 13.5 36.65 17.65 36.65 23.35H44.6V40.15H27.05Z"></path>\n            </svg>\n        </div>\n        <p class="font-size-md text-align-center">{{ .body | markdownify }}</p>\n        <div class="text-align-center">\n            <div class="testimonial__image">\n                <img src="{{ .image.image_url }}" alt="{{ .image.image_alt }}" width="50" height="50">\n            </div>\n            <div class="fw-600">{{ .name }}</div>\n            <div class="text-style-slub">{{ .title }}</div>\n        </div>\n    </div>\n</div>\n  ';

  // bookshop-import-file:components/testimonial/testimonial.hugo.html__bookshop_file__
  var testimonial_hugo_default2 = testimonial_hugo_default;

  // component-library/components/testimonials-slider/testimonials-slider.hugo.html
  var testimonials_slider_hugo_default = '<section class="testimonials block bg-{{ .background_color }}" aria-labelledby="{{ .heading | urlize }}">\n    <div class="grid">\n        <div class="testimonials__content">\n            <h2 id="{{ .heading | urlize }}">{{ .heading }}</h2>\n            <p>{{ .body | markdownify }}</p>\n        </div>\n    </div>\n    <div class="grid">\n        <div class="reel p-relative" tabindex="0">\n            {{ range .testimonials }}\n            <div class="reel__testimonial">\n                <p class="reel__body">"{{ .body | markdownify }}"</p>\n                <img class="reel__image" src="{{ .image }}" alt="Headshot of {{ .title }}, {{ .name }}">\n                <p class="text-style-slub">{{ .name }}</p>\n                <p class="font-size-xs">{{ .title }}</p>\n            </div>\n            {{ end }}\n        </div>\n    </div>\n</section>';

  // bookshop-import-file:components/testimonials-slider/testimonials-slider.hugo.html__bookshop_file__
  var testimonials_slider_hugo_default2 = testimonials_slider_hugo_default;

  // component-library/shared/hugo/page.hugo.html
  var page_hugo_default = '{{ range . }}\n  {{ partial "bookshop" . }}\n{{ end }}\n';

  // bookshop-import-file:shared/hugo/page.hugo.html__bookshop_file__
  var page_hugo_default2 = page_hugo_default;

  // bookshop-import-glob:(.hugo.html)
  var files = {};
  files["components/blog-feed/blog-feed.hugo.html"] = blog_feed_hugo_default2;
  files["components/careers-feed/careers-feed.hugo.html"] = careers_feed_hugo_default2;
  files["components/columns/columns.hugo.html"] = columns_hugo_default2;
  files["components/content/content.hugo.html"] = content_hugo_default2;
  files["components/cta/cta.hugo.html"] = cta_hugo_default2;
  files["components/double-cta/double-cta.hugo.html"] = double_cta_hugo_default2;
  files["components/hero-simple/hero-simple.hugo.html"] = hero_simple_hugo_default2;
  files["components/hero-split/hero-split.hugo.html"] = hero_split_hugo_default2;
  files["components/hero-two-column/hero-two-column.hugo.html"] = hero_two_column_hugo_default2;
  files["components/hero/hero.hugo.html"] = hero_hugo_default2;
  files["components/icon-card/icon-card.hugo.html"] = icon_card_hugo_default2;
  files["components/intro/intro.hugo.html"] = intro_hugo_default2;
  files["components/media-text/media-text.hugo.html"] = media_text_hugo_default2;
  files["components/numbers/numbers.hugo.html"] = numbers_hugo_default2;
  files["components/services-feed/services-feed.hugo.html"] = services_feed_hugo_default2;
  files["components/staff-feed/staff-feed.hugo.html"] = staff_feed_hugo_default2;
  files["components/testimonial/testimonial.hugo.html"] = testimonial_hugo_default2;
  files["components/testimonials-slider/testimonials-slider.hugo.html"] = testimonials_slider_hugo_default2;
  files["shared/hugo/page.hugo.html"] = page_hugo_default2;
  var hugo_default = files;

  // bookshop-import-config:bookshop.config.js
  var engines = [];
  var Engine0Plugins = [];
  engines.push(new Engine({
    ...{ "plugins": [] },
    files: hugo_default,
    plugins: Engine0Plugins
  }));
  var bookshop_config_default = engines;

  // node_modules/@bookshop/live/lib/app/app.js
  window.BookshopLive = getLive(bookshop_config_default);
})();
/*! *****************************************************************************
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at http://www.apache.org/licenses/LICENSE-2.0

THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED
WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,
MERCHANTABLITY OR NON-INFRINGEMENT.

See the Apache Version 2.0 License for specific language governing permissions
and limitations under the License.
***************************************************************************** */
