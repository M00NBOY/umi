Source of the engine in engine/ponscr.wasm (GNU GPL version 2, see COPYING).

It is Ponscripter, https://github.com/chronotrig/ponscripter-fork-wh at commit
9aaae158e92bb9235bad261368fb66b2f7bfc0fd,
with engine.patch applied, built with Emscripten by web/Makefile:

  git clone https://github.com/chronotrig/ponscripter-fork-wh engine
  git -C engine checkout 9aaae15
  git -C engine apply ../engine.patch
  make -C web
