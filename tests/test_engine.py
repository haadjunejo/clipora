"""Engine logic that needs no GPU, network or video files."""
import json
import types

from clipora import config, meta, picker, pipeline, publish, render, youtube

WORDS = [{"w": "Hello", "s": 0.0, "e": 0.4}, {"w": "um", "s": 0.5, "e": 0.7}, {"w": "world.", "s": 0.8, "e": 1.2},
         {"w": "Next", "s": 3.5, "e": 3.9}, {"w": "thing", "s": 4.0, "e": 4.4}]


def test_clean_options_limits_and_defaults():
    o = config.clean_options({"num_clips": 250, "caption_style": "nope", "aspect": "1:1", "crop_x": 7})
    assert o["num_clips"] == config.MAX_CLIPS
    assert o["caption_style"] == config.DEFAULT_OPTIONS["caption_style"]
    assert o["aspect"] == "1:1" and o["crop_x"] == 1.0
    assert config.clean_options({"num_clips": 0})["num_clips"] == 0  # 0 = auto
    assert config.clean_options({"max_sec": 10, "min_sec": 30})["max_sec"] >= 35


def test_clip_overrides_only_return_given_keys():
    o = config.clean_options({"caption_size": "130", "bogus": 1}, only=config.CLIP_OVERRIDE_KEYS)
    assert o == {"caption_size": 130}


def test_every_caption_style_builds():
    for style in config.CAPTION_STYLES:
        opts = render.clip_options(config.clean_options({"caption_style": style}), {})
        ass = render.build_ass(WORDS, 5, opts, "Hook", 1080, 1920)
        assert "[Events]" in ass and ("Dialogue: 1" in ass)  # the hook line is always there


def test_karaoke_lights_words_progressively():
    opts = render.clip_options(config.clean_options({"caption_style": "karaoke"}), {})
    lines = [l for l in render.build_ass(WORDS, 5, opts).splitlines() if l.startswith("Dialogue: 0")]
    assert any(l.count("\\c&H") >= 4 for l in lines)  # two highlighted words in one line


def test_cuts_fillers_silences_and_retime():
    opts = render.clip_options(config.DEFAULT_OPTIONS, {"remove_fillers": True, "remove_silences": True})
    shifted = [{**w, "s": w["s"] + 10, "e": w["e"] + 10} for w in WORDS]
    cuts = render.compute_cuts({}, opts, shifted, 10, 15)
    assert any(abs(a - 0.5) < 0.01 for a, b in cuts)  # the "um"
    assert any(b - a > 1.5 for a, b in cuts)  # the long pause
    kept = [w["w"] for w in render.retime_words(WORDS, cuts)]
    assert "um" not in kept and kept[0] == "Hello"


def test_split_regions_stay_inside_frame():
    top_h, top, bottom = render.split_regions(1920, 1080, 1080, 1920, (1700, 90, 200, 90), crop_x=0.5)
    assert top_h == 960
    for x, y, w, h in (top, bottom):
        assert x >= 0 and y >= 0 and x + w <= 1920 and y + h <= 1080


def test_auto_clip_count():
    assert pipeline.auto_clip_count(5 * 60, {"max_sec": 75}) == 3
    assert pipeline.auto_clip_count(10 * 3600, {"max_sec": 75}) == config.MAX_CLIPS


def test_picker_json_and_heuristic():
    got = picker.parse_json_clips('```json\n{"clips":[{"start":1,"end":20,"score":90,"hashtags":["a"]}]}\n```')
    assert got[0]["hashtags"] == ["#a"]
    segs = [{"s": i * 5.0, "e": i * 5.0 + 4.5, "text": f"Why is this the biggest secret number {i}?"} for i in range(40)]
    clips = picker.heuristic_clips(segs, 3, 15, 30)
    assert len(clips) == 3 and all(15 <= c["end"] - c["start"] <= 30 for c in clips)


def test_publish_caption_rules():
    post = {"description": "Watch this", "hashtags": [f"#t{i}" for i in range(40)]}
    assert "#Shorts" in publish.caption(post, "yt", short=True)
    assert publish.caption(post, "ig").count("#") == 30  # Instagram max


def test_paste_parsing():
    code, state = youtube.parse_pasted("http://localhost:8000/api/connect/youtube/callback?state=abc&code=XYZ&scope=s")
    assert (code, state) == ("XYZ", "abc")
    code, state = meta.parse_pasted("http://localhost:8000/api/connect/meta/callback?code=M1&state=s1#_=_")
    assert (code, state) == ("M1", "s1")


def _resp(code, body):
    r = types.SimpleNamespace(status_code=code, text=json.dumps(body))
    r.json = lambda: body
    return r


def test_meta_errors_are_readable():
    assert "spam" in meta._err(_resp(400, {"error": {"code": 9, "error_subcode": 2207051, "message": "x"}}))
    assert "ProcessingFailedError" in meta._err(_resp(400, {"debug_info": {"type": "ProcessingFailedError", "message": "m"}}))
