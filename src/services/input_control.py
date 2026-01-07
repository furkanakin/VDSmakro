import ctypes
import sys
import json
import time
import os

# Windows API Constants
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_WHEEL = 0x0800
KEYEVENTF_KEYUP = 0x0002

user32 = ctypes.windll.user32

# Key Map
VK_MAP = {
    "Enter": 0x0D, "Backspace": 0x08, "Tab": 0x09, "Escape": 0x1B, " ": 0x20,
    "ArrowLeft": 0x25, "ArrowUp": 0x26, "ArrowRight": 0x27, "ArrowDown": 0x28,
    "Delete": 0x2E, "Control": 0x11, "Shift": 0x10, "Alt": 0x12, "Home": 0x24,
    "End": 0x23, "PageUp": 0x21, "PageDown": 0x22
}

def mouse_move(x, y):
    user32.SetCursorPos(int(x), int(y))

def mouse_click(x, y, button='left'):
    mouse_move(x, y)
    time.sleep(0.01)
    if button == 'left':
        user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    elif button == 'right':
        user32.mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)
        user32.mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)

def mouse_scroll(delta):
    user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, int(-delta), 0)

def key_press(key):
    vk = None
    if key in VK_MAP:
        vk = VK_MAP[key]
    elif len(key) == 1:
        res = user32.VkKeyScanW(ord(key))
        if res != -1:
            vk = res & 0xFF
    
    if vk:
        user32.keybd_event(vk, 0, 0, 0)
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)

def main():
    if len(sys.argv) < 2:
        return

    try:
        data = json.loads(sys.argv[1])
        t = data.get("type")
        
        if t == "click":
            mouse_click(data["x"], data["y"], "left")
        elif t == "right-click":
            mouse_click(data["x"], data["y"], "right")
        elif t == "scroll":
            mouse_scroll(data["delta"])
        elif t == "keydown":
            key_press(data["key"])
        elif t == "text":
            for char in data["text"]:
                key_press(char)
                time.sleep(0.01)
            
    except Exception as e:
        sys.stderr.write(str(e))

if __name__ == "__main__":
    main()
