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

/* Plays a movie with the browser's own decoder; returns once it has ended
 * or, when click_flag is set, been dismissed by the reader. */
void web_play_video(const pstring& filename, bool click_flag);

/* Hands the thread back to the browser if the engine has held it for longer
 * than a frame. Called from the engine's main loop. */
void web_yield_if_due();

#endif
