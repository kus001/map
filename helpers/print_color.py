"""
Copyright © 2026 Madhav Garg <gargm0325@wrdsb.ca>

Licensed under the MIT License (the "License"); you may not use this file 
except in compliance with the License. You may obtain a copy of the License 
at https://opensource.org

File sourced from: https://github.com/roc-ket-cod-er/Python-Transit-API/blob/main/src/print_color.py
"""

import os
import asyncio
from aioconsole import ainput

#----------- Text Colors -----------
NORMAL_TEXT = "\033[0m"

RED = '\033[0;31m'
BLUE = '\033[0;34m'	
GREEN = '\033[0;32m'
YELLOW = '\033[0;33m'
MAGENTA = '\033[0;35m'

NORMAL = 'normal'

BOLD = '\033[1;37m'

def magenta(*strings, end='', bold=False):
    tbr = MAGENTA
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def red(*strings, end='', bold=False):
    tbr = RED
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def green(*strings, end='', bold=False):
    tbr = GREEN
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def blue(*strings, end='', bold=False):
    tbr = BLUE
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def yellow(*strings, end='', bold=False):
    tbr = YELLOW
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def bold(*strings, end=''):
    tbr = BOLD
    for string in strings:
        if string[:4] != '\033[0;':
            tbr += str(string)
            if string != strings[-1]:
                tbr += ' '
        else:
            tbr += NORMAL_TEXT
            tbr += '\033[1;'
            tbr += string[4:]
            if string != strings[-1]:
                tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr




class Screen:
    def __init__(self):
        self.screen = ''
        self.IS_WINDOWS = True if os.name == 'nt' else False
        self.pinned_text = ''
    
    def clear(self):
        if self.IS_WINDOWS:
            os.system("cls")
        else:
            os.system("clear")
        self.screen = ''
        print(self.pinned_text, flush=True)

    def print(self, *all_to_print, end='\n'):
        for to_print in all_to_print:
            to_print = str(to_print)
            self.screen += to_print
            escape_detected = False
            for char in to_print:
                if char == '\033':
                    escape_detected=True

                if escape_detected:
                    if char != 'm':
                        print(char, end='', flush=True)
                        continue
                    else:
                        escape_detected=False

                print(char, end='', flush=True)
                if char == '\n':
                    continue
        self.screen += end
        print(end=end, flush=True)

    async def type(self, *all_to_print, delay: float = 0.02, end: str = '\n'):
        for to_print in all_to_print:
            to_print = str(to_print)
            escape_detected = False
            for char in to_print:
                if char == '\033':
                    escape_detected=True
                    print(char, end='', flush=True)
                    self.screen += char
                    continue

                if escape_detected:
                    if char != 'm':
                        print(char, end='', flush=True)
                        self.screen += char
                        continue
                    else:
                        escape_detected=False
                        print(char, end='', flush=True)
                        self.screen += char
                        continue

                print(char, end='', flush=True)
                self.screen += char
                await asyncio.sleep(delay)
        self.print(end=end)

    async def input(self):
        inp = await ainput()
        self.screen += inp + '\n'
        return inp
    
    def _scroll(self, rows=1):
        temp_screen = self.screen.split('\n')
        temp_screen = temp_screen[rows:]
        self.clear()
        self.screen = '\n'.join(temp_screen)
        print(self.screen, end='', flush=True)

    async def scroll(self, rows, time_per_row=0.4):
        for _ in range(rows):
            self._scroll(1)
            await asyncio.sleep(time_per_row)

    def delete_last_lines(self, lines=1):
        temp_screen = self.screen.split('\n')
        temp_screen = temp_screen[:-lines]

        self.clear()
        self.screen = '\n'.join(temp_screen) + '\n'
        print(self.screen, end='', flush=True)

    def remove_to_line(self, line):
        temp_screen = self.screen.split('\n')
        temp_screen = temp_screen[:line]

        self.clear()
        self.screen = '\n'.join(temp_screen) + '\n'
        print(self.screen, end='', flush=True)

    @property
    def lines(self):
        return self.screen.split('\n')
    
    @property
    def nlines(self):
        return len(self.lines)