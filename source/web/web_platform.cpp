/* Browser glue for the Emscripten build of Ponscripter; see web_platform.h. */
#include "web_platform.h"
#include "ScriptHandler.h"
#include "Fontinfo.h"

#include <SDL.h>
#include <bzlib.h>
#include <emscripten.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#define MANIFEST_FILE "manifest.tsv"

// Copies the file if the host page already has it in memory, without
// suspending the engine. Returns -2 when it has to be downloaded.
EM_JS(int, web_js_cached, (const char* key, int length, unsigned char* dst), {
    return Module.ponsCached(UTF8ToString(key), length, dst);
});

// Both calls are implemented by the host page (shell.js) and may take
// arbitrarily long: the page retries failed downloads until they succeed.
EM_ASYNC_JS(int, web_js_fetch_async, (const char* key, int length, unsigned char* dst), {
    return await Module.ponsFetch(UTF8ToString(key), length, dst);
});

static int web_js_fetch(const char* key, int length, unsigned char* dst)
{
    int got = web_js_cached(key, length, dst);
    return got == -2 ? web_js_fetch_async(key, length, dst) : got;
}

EM_JS(void, web_js_text_glyph, (int unicode, int r, int g, int b, int style,
                                int size, int base_size), {
    if (Module.ponsTextGlyph) Module.ponsTextGlyph(unicode, (r << 16) | (g << 8) | b, style, size / base_size);
});

EM_JS(void, web_js_text_event, (int event), {
    if (Module.ponsTextEvent) Module.ponsTextEvent(event);
});

void web_text_glyph(unsigned short unicode, int r, int g, int b, int style,
                    int size, int base_size)
{
    web_js_text_glyph(unicode, r, g, b, style, size, base_size ? base_size : size);
}

void web_text_event(int event) { web_js_text_event(event); }

void web_note_text_window(bool shown)
{
    static int last = -1;
    if (last == (int) shown) return;
    last = shown;
    web_js_text_event(shown ? WEB_TEXT_WINDOW_SHOWN : WEB_TEXT_WINDOW_HIDDEN);
}

EM_ASYNC_JS(void, web_js_play_video, (const char* key, int click_flag), {
    await Module.ponsPlayVideo(UTF8ToString(key), !!click_flag);
});

// Resolves on the next task, without the 4 ms floor of nested timers.
EM_ASYNC_JS(void, web_js_yield, (), {
    await new Promise((resolve) => {
        const channel = (Module.ponsYieldChannel ??= new MessageChannel());
        channel.port1.onmessage = resolve;
        channel.port2.postMessage(0);
    });
});

#define YIELD_INTERVAL_MS 12.0

void web_yield_if_due()
{
    static double last_yield = 0;
    if (emscripten_get_now() - last_yield < YIELD_INTERVAL_MS) return;
    web_js_yield();
    last_yield = emscripten_get_now();
}


WebReader::WebReader(DirPaths* path, const unsigned char* key_table)
    : DirectReader(path, key_table)
{
    // One line per file: key <TAB> stored length <TAB> compression <TAB> original length
    FILE* fp = fopen(MANIFEST_FILE, "rb");
    if (!fp) {
        fprintf(stderr, "WebReader: no %s, only preloaded files are available\n",
                MANIFEST_FILE);
        return;
    }
    char line[2048];
    while (fgets(line, sizeof(line), fp)) {
        char* tab = strchr(line, '\t');
        if (!tab) continue;
        *tab = 0;
        Entry e;
        unsigned long stored = 0, original = 0;
        int type = 0;
        if (sscanf(tab + 1, "%lu\t%d\t%lu", &stored, &type, &original) != 3)
            continue;
        e.stored_length = stored;
        e.compression_type = type;
        e.original_length = original ? original : stored;
        entries[line] = e;
    }
    fclose(fp);
}


std::string WebReader::normalise(const pstring& file_name)
{
    std::string key((const char*) file_name);
    for (size_t i = 0; i < key.size(); ++i) {
        char& c = key[i];
        if (c == '\\') c = '/';
        else if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
    }
    size_t start = 0;
    while (key.compare(start, 2, "./") == 0) start += 2;
    while (start < key.size() && key[start] == '/') ++start;
    return key.substr(start);
}


const WebReader::Entry* WebReader::find(const pstring& file_name) const
{
    std::unordered_map<std::string, Entry>::const_iterator it =
        entries.find(normalise(file_name));
    return it == entries.end() ? NULL : &it->second;
}


size_t WebReader::getFileLength(const pstring& file_name)
{
    const Entry* e = find(file_name);
    if (e) return e->original_length;
    return DirectReader::getFileLength(file_name);
}


size_t WebReader::getFile(const pstring& file_name, unsigned char* buffer,
                          int* location)
{
    const Entry* e = find(file_name);
    if (!e) return DirectReader::getFile(file_name, buffer, location);

    if (location) *location = ARCHIVE_TYPE_NSA;
    std::string key = normalise(file_name);

    if (e->compression_type == NO_COMPRESSION) {
        int got = web_js_fetch(key.c_str(), (int) e->stored_length, buffer);
        return got < 0 ? 0 : (size_t) got;
    }

    if (e->compression_type != NBZ_COMPRESSION) {
        fprintf(stderr, "WebReader: unsupported compression %d for %s\n",
                e->compression_type, key.c_str());
        return 0;
    }

    // NBZ: big-endian original length followed by a bzip2 stream.
    unsigned char* packed = (unsigned char*) malloc(e->stored_length);
    if (!packed) return 0;
    size_t result = 0;
    int got = web_js_fetch(key.c_str(), (int) e->stored_length, packed);
    if (got > 4) {
        unsigned int out_len = (unsigned int) e->original_length;
        int err = BZ2_bzBuffToBuffDecompress((char*) buffer, &out_len,
                                             (char*) packed + 4, got - 4, 0, 0);
        if (err == BZ_OK) result = out_len;
        else fprintf(stderr, "WebReader: bzip2 error %d for %s\n", err, key.c_str());
    }
    free(packed);
    return result;
}


void web_play_video(const pstring& filename, bool click_flag)
{
    pstring key = filename;
    key.findreplace("\\", "/");
    web_js_play_video((const char*) key, click_flag ? 1 : 0);
}


static bool text_off_picture = false;
static int sprites_off_picture[2] = { -1, -1 };
static bool repaint_pending = false;
static int log_sprite = -1;

void web_set_log_sprite(int sprite_no) { log_sprite = sprite_no; }

bool web_text_off_picture() { return text_off_picture; }

bool web_sprite_off_picture(int sprite_no)
{
    return text_off_picture &&
        (sprite_no == sprites_off_picture[0] || sprite_no == sprites_off_picture[1] ||
         sprite_no == log_sprite);
}

bool web_take_repaint()
{
    bool pending = repaint_pending;
    repaint_pending = false;
    return pending;
}

extern "C" EMSCRIPTEN_KEEPALIVE void web_set_text_off_picture(int off, int sprite1, int sprite2)
{
    if (text_off_picture == !!off && sprites_off_picture[0] == sprite1 &&
        sprites_off_picture[1] == sprite2) return;
    text_off_picture = !!off;
    sprites_off_picture[0] = sprite1;
    sprites_off_picture[1] = sprite2;
    repaint_pending = true;
}


static ScriptHandler* web_script = NULL;
static const char* web_text_position = NULL;

void web_set_script(ScriptHandler* script)
{
    web_script = script;
    web_text_position = NULL;
}

void web_note_text(const char* position)
{
    web_text_position = position;
}


/* Called by the page while the engine is suspended. None of these run script
 * or touch engine state, so that is safe. */
extern "C" {

/* Address of the text last shown (0 before the first), and of the end of the
 * script: the page reads the bytes in between straight from the heap. */
EMSCRIPTEN_KEEPALIVE const char* web_text_cursor() { return web_text_position; }

EMSCRIPTEN_KEEPALIVE const char* web_script_end()
{
    return web_script ? web_script->webScriptEnd() : NULL;
}

static char web_name[256];
EMSCRIPTEN_KEEPALIVE char* web_name_buffer() { return web_name; }

/* Resolves the lower-cased name in web_name_buffer(): the current value of
 * the string variable $name, or the string alias `name`. NULL if unknown. */
EMSCRIPTEN_KEEPALIVE const char* web_font_file(int style)
{
    return FontFileName(style);
}

EMSCRIPTEN_KEEPALIVE const char* web_resolve(int variable)
{
    if (!web_script) return NULL;
    web_name[sizeof(web_name) - 1] = 0;
    return variable ? web_script->webStrVariable(web_name)
                    : web_script->webStrAlias(web_name);
}

}


/* Input injected by the page's on-screen controls. These only queue events,
 * so they are safe to call while the engine is suspended. */
extern "C" {

EMSCRIPTEN_KEEPALIVE void web_push_key(int sym, int down)
{
    SDL_Event event;
    SDL_zero(event);
    event.type = down ? SDL_KEYDOWN : SDL_KEYUP;
    event.key.state = down ? SDL_PRESSED : SDL_RELEASED;
    event.key.keysym.sym = sym;
    SDL_PushEvent(&event);
}

EMSCRIPTEN_KEEPALIVE void web_push_button(int button, int down)
{
    SDL_Event event;
    SDL_zero(event);
    event.type = down ? SDL_MOUSEBUTTONDOWN : SDL_MOUSEBUTTONUP;
    event.button.button = button;
    event.button.state = down ? SDL_PRESSED : SDL_RELEASED;
    SDL_GetMouseState(&event.button.x, &event.button.y);
    SDL_PushEvent(&event);
}

/* A pointer at (x, y) in game pixels: moved there (button 0), or pressed or
 * released there. Used when the page shows the picture rotated, where the
 * browser's own coordinates mean nothing to SDL. */
EMSCRIPTEN_KEEPALIVE void web_push_pointer(int x, int y, int button, int down)
{
    SDL_Event event;
    SDL_zero(event);
    if (!button) {
        event.type = SDL_MOUSEMOTION;
        event.motion.x = x;
        event.motion.y = y;
    }
    else {
        event.type = down ? SDL_MOUSEBUTTONDOWN : SDL_MOUSEBUTTONUP;
        event.button.button = button;
        event.button.state = down ? SDL_PRESSED : SDL_RELEASED;
        event.button.x = x;
        event.button.y = y;
    }
    SDL_PushEvent(&event);
}

EMSCRIPTEN_KEEPALIVE void web_push_wheel(int y)
{
    SDL_Event event;
    SDL_zero(event);
    event.type = SDL_MOUSEWHEEL;
    event.wheel.y = y;
    SDL_PushEvent(&event);
}

}
