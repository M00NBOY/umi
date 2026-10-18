# Web (Emscripten) build of ponscripter-fork-wh.
#   source ../emsdk/emsdk_env.sh && make
SRC := ../engine/src
OUT := build
DIST := dist

CXX := em++
CC := emcc

PORTS := --use-port=sdl2 --use-port=sdl2_image:formats=png,jpg,bmp \
	--use-port=sdl2_mixer --use-port=freetype --use-port=bzip2 \
	--use-port=vorbis --use-port=ogg --use-port=zlib

DEFS := -DLINUX -DUSE_OGG_VORBIS -DUTF8_CAPTION -DUTF8_FILESYSTEM
OPT ?= -O2
# The engine predates compilers that exploit undefined behaviour this hard.
SAFE := -fno-strict-aliasing -fwrapv -fno-delete-null-pointer-checks
CFLAGS := $(OPT) $(SAFE) $(DEFS) -Istubs -I. -I$(SRC) $(PORTS) -Wno-everything -MMD -MP
CXXFLAGS := $(CFLAGS) -std=gnu++14

ENGINE := Ponscripter PonscripterLabel PonscripterMessage PonscripterLabel_command \
	PonscripterLabel_text PonscripterLabel_effect PonscripterLabel_effect_breakup \
	PonscripterLabel_effect_cascade PonscripterLabel_effect_trig PonscripterLabel_event \
	PonscripterLabel_rmenu PonscripterLabel_animation PonscripterLabel_sound \
	PonscripterLabel_file PonscripterLabel_file2 PonscripterLabel_image \
	PonscripterLabel_ext AnimationInfo Fontinfo DirtyRect resize_image encoding font \
	bstrwrap pstring cp932_encoding expression prng DirectReader SarReader NsaReader \
	ScriptHandler ScriptParser ScriptParser_command DirPaths

OBJS := $(ENGINE:%=$(OUT)/%.o) $(OUT)/bstrlib.o $(OUT)/resources.o $(OUT)/web_platform.o

LDOPT ?= $(OPT)
# --profiling-funcs keeps function names so a crash report is readable.
LDFLAGS := $(LDOPT) $(PORTS) \
	-sASYNCIFY -sASYNCIFY_STACK_SIZE=131072 \
	-sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=268435456 -sSTACK_SIZE=2097152 \
	-sEXPORTED_RUNTIME_METHODS=FS,callMain,UTF8ToString,HEAPU8 \
	-sEXPORTED_FUNCTIONS=_main,_malloc,_free \
	-sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sENVIRONMENT=web \
	-sMODULARIZE -sEXPORT_NAME=createPonscripter \
	--profiling-funcs

all: $(DIST)/ponscr.js

$(DIST)/ponscr.js: $(OBJS) | $(DIST)
	$(CXX) -o $@ $(OBJS) $(LDFLAGS) $(LDEXTRA)

$(OUT)/%.o: $(SRC)/%.cpp | $(OUT)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(OUT)/bstrlib.o: $(SRC)/bstrlib.c | $(OUT)
	$(CC) $(CFLAGS) -c $< -o $@

$(OUT)/web_platform.o: web_platform.cpp web_platform.h | $(OUT)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(OUT)/resources.o: $(OUT)/resources.cpp
	$(CXX) $(CXXFLAGS) -c $< -o $@

# No embedded resources: fonts and icon come from the game data.
$(OUT)/resources.cpp: $(OUT)/embed | $(OUT)
	$(OUT)/embed > $@

$(OUT)/embed: $(SRC)/embed.cpp | $(OUT)
	c++ $< -o $@

$(OUT) $(DIST):
	mkdir -p $@

-include $(OBJS:.o=.d)

clean:
	rm -rf $(OUT) $(DIST)/ponscr.js $(DIST)/ponscr.wasm

.PHONY: all clean
