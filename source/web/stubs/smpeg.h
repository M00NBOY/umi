/* Stub of the SMPEG API for the web build: MPEG decoding is not compiled in.
 * Movies are played by the browser's <video> element instead (see web_platform.cpp),
 * and the game's music is Ogg Vorbis, so every entry point here reports failure. */
#ifndef WEB_SMPEG_STUB_H
#define WEB_SMPEG_STUB_H

#include <SDL.h>

typedef struct _SMPEG SMPEG;

typedef struct SMPEG_Frame {
    unsigned int w, h;
    unsigned int image_width, image_height;
    Uint8* image;
} SMPEG_Frame;

typedef struct _SMPEG_Info {
    int has_audio;
    int has_video;
    int width;
    int height;
    int current_frame;
    double current_fps;
    char audio_string[80];
    int audio_current_frame;
    Uint32 current_offset;
    Uint32 total_size;
    double current_time;
    double total_time;
} SMPEG_Info;

typedef enum { SMPEG_ERROR = -1, SMPEG_STOPPED, SMPEG_PLAYING } SMPEGstatus;

typedef void (*SMPEG_DisplayCallback)(void* data, SMPEG_Frame* frame);

static inline SMPEG* SMPEG_new(const char*, SMPEG_Info*, int) { return NULL; }
static inline SMPEG* SMPEG_new_rwops(SDL_RWops* src, SMPEG_Info*, int freesrc, int)
{
    if (src && freesrc) SDL_RWclose(src);
    return NULL;
}
static inline const char* SMPEG_error(SMPEG*) { return "MPEG playback is not available in the web build"; }
static inline void SMPEG_getinfo(SMPEG*, SMPEG_Info* info) { if (info) SDL_memset(info, 0, sizeof(*info)); }
static inline void SMPEG_enableaudio(SMPEG*, int) {}
static inline void SMPEG_enablevideo(SMPEG*, int) {}
static inline void SMPEG_delete(SMPEG*) {}
static inline SMPEGstatus SMPEG_status(SMPEG*) { return SMPEG_STOPPED; }
static inline void SMPEG_setvolume(SMPEG*, int) {}
static inline void SMPEG_setdisplay(SMPEG*, SMPEG_DisplayCallback, void*, SDL_mutex*) {}
static inline void SMPEG_play(SMPEG*) {}
static inline void SMPEG_stop(SMPEG*) {}
static inline int SMPEG_playAudio(SMPEG*, Uint8*, int) { return 0; }
static inline int SMPEG_wantedSpec(SMPEG*, SDL_AudioSpec*) { return 0; }
static inline void SMPEG_actualSpec(SMPEG*, SDL_AudioSpec*) {}

#endif
