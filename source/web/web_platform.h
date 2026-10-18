/* Browser glue for the Emscripten build of Ponscripter.
 *
 * WebReader resolves each file through a manifest supplied by the host page.
 * A file the page already holds (it downloads ahead of the reader) is copied
 * in directly; otherwise the engine is suspended (Asyncify) while the page
 * downloads it. */
#ifndef WEB_PLATFORM_H
#define WEB_PLATFORM_H

#include "DirectReader.h"
#include <string>
#include <unordered_map>

class WebReader : public DirectReader {
public:
    WebReader(DirPaths* path = NULL, const unsigned char* key_table = 0);

    pstring getArchiveName() const { return "web"; }
    size_t getFileLength(const pstring& file_name);
    size_t getFile(const pstring& file_name, unsigned char* buffer,
                   int* location = NULL);

private:
    struct Entry {
        size_t stored_length;   // bytes to download
        size_t original_length; // bytes once decompressed
        int compression_type;
    };
    std::unordered_map<std::string, Entry> entries;

    static std::string normalise(const pstring& file_name);
    const Entry* find(const pstring& file_name) const;
};

/* Asset look-ahead: the page reads the script that follows the text being
 * shown and downloads what it is about to need. The engine only tells it
 * where the reader is and resolves the script's names for it. */
class ScriptHandler;
void web_set_script(ScriptHandler* script);
void web_note_text(const char* position);

/* The text of the page being read, passed on as it is drawn so the page can
 * show it again in large print (a phone held upright): each glyph with its
 * colour, style (the face it is drawn with, see web_font_file) and size, and
 * what happens to the page. A redraw of the whole page (after the menu, or in
 * the backlog) comes between RESTORE_BEGIN and RESTORE_END. */
enum {
    WEB_TEXT_CLEAR,
    WEB_TEXT_NEWLINE,
    WEB_TEXT_RESTORE_BEGIN,
    WEB_TEXT_RESTORE_END,
    WEB_TEXT_CLICK_WAIT, // waiting for a click within the page
    WEB_TEXT_PAGE_WAIT,  // waiting for a click to turn the page
    WEB_TEXT_GO,         // clicked: the text goes on
    WEB_TEXT_LOG_BEGIN,  // a backlog page follows, glyph by glyph
    WEB_TEXT_LOG_END,
    WEB_TEXT_ON,         // the text window is shown again (after the backlog)
    WEB_TEXT_WINDOW_SHOWN,  // the text window appears on the picture
    WEB_TEXT_WINDOW_HIDDEN, // ...or is taken off it (scene change, movie...)
};
void web_text_glyph(unsigned short unicode, int r, int g, int b, int style,
                    int size, int base_size);
void web_text_event(int event);
/* Called whenever the screen is updated: reports WINDOW_SHOWN/HIDDEN on change. */
void web_note_text_window(bool shown);

/* With the text shown under the picture instead, the picture is drawn
 * without it: no text, no text window, and none of the sprites the page
 * named (the game's own click-wait icons). The page sets this through
 * web_set_text_off_picture; the event loop then repaints everything. */
bool web_text_off_picture();
void web_set_log_sprite(int sprite_no);
void web_report_glyphs(bool on); // in PonscripterLabel_text.cpp
bool web_sprite_off_picture(int sprite_no);
bool web_take_repaint();

/* Plays a movie with the browser's own decoder; returns once it has ended
 * or, when click_flag is set, been dismissed by the reader. */
void web_play_video(const pstring& filename, bool click_flag);

/* Hands the thread back to the browser if the engine has held it for longer
 * than a frame. Called from the engine's main loop. */
void web_yield_if_due();

#endif
