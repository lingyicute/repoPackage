import os
import sys
import subprocess
import tempfile
import time
import shutil
import winreg
import ctypes
import tkinter as tk
from tkinter import font
import requests
from ctypes import windll
import logging
import traceback
from datetime import datetime

# 配置日志系统
def setup_logging():
    """设置日志系统"""
    log_dir = os.path.dirname(os.path.abspath(__file__))
    log_file = os.path.join(log_dir, f"timer_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
    
    # 配置根日志记录器
    logger = logging.getLogger()
    logger.setLevel(logging.DEBUG)
    
    # 创建文件处理器
    file_handler = logging.FileHandler(log_file, encoding='utf-8')
    file_handler.setLevel(logging.DEBUG)
    
    # 设置格式
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    file_handler.setFormatter(formatter)
    
    # 添加处理器到日志记录器
    logger.addHandler(file_handler)
    
    logging.info("=== 日志系统初始化完成 ===")
    logging.info(f"Python版本: {sys.version}")
    logging.info(f"操作系统: {sys.platform}")
    logging.info(f"日志文件位置: {log_file}")
    
    return log_file

# Windows常量
CREATE_NO_WINDOW = 0x08000000

def is_admin():
    """检查程序是否以管理员权限运行。"""
    try:
        return ctypes.windll.shell32.IsUserAnAdmin()
    except:
        logging.exception("检查管理员权限失败")
        return False

def run_as_subprocess():
    """启动子进程并退出主进程，避免阻塞控制台。"""
    script_path = os.path.abspath(sys.argv[0])
    
    try:
        # 创建不显示控制台窗口的子进程
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        
        logging.info(f"正在启动子进程: {script_path}")
        subprocess.Popen(
            [sys.executable, script_path, "subprocess"],
            startupinfo=startupinfo,
            creationflags=CREATE_NO_WINDOW
        )
    except Exception:
        logging.exception("使用startupinfo启动子进程失败，尝试普通方式")
        # 如果上述方法失败，使用普通方式启动子进程
        subprocess.Popen([sys.executable, script_path, "subprocess"])
    
    logging.info("主进程准备退出")
    sys.exit(0)

def download_font(url, target_path):
    """从GitHub下载字体文件。"""
    logging.info(f"开始下载字体，URL: {url}, 目标路径: {target_path}")
    try:
        response = requests.get(url, stream=True)
        response.raise_for_status()
        
        with open(target_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        success = os.path.exists(target_path) and os.path.getsize(target_path) > 0
        logging.info(f"字体下载{'成功' if success else '失败'}, 文件大小: {os.path.getsize(target_path) if success else 0} 字节")
        return success
    except Exception:
        logging.exception("下载字体失败")
        return False

def preload_font(font_path):
    """预加载字体，确保系统可识别"""
    logging.info(f"开始预加载字体: {font_path}")
    if not os.path.exists(font_path):
        logging.error(f"字体文件不存在: {font_path}")
        return False, None
        
    try:
        # 确保字体目录存在
        app_font_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
        if not os.path.exists(app_font_dir):
            os.makedirs(app_font_dir)
            logging.info(f"创建字体目录: {app_font_dir}")
            
        # 将字体复制到应用字体目录
        local_font_path = os.path.join(app_font_dir, os.path.basename(font_path))
        if font_path != local_font_path:
            shutil.copy(font_path, local_font_path)
            logging.info(f"复制字体文件: {font_path} -> {local_font_path}")

        # 加载字体资源
        HWND_BROADCAST = 0xFFFF
        WM_FONTCHANGE = 0x001D
        
        if hasattr(windll, 'gdi32'):
            gdi32 = windll.gdi32
            if hasattr(gdi32, 'AddFontResourceExW'):
                # 使用更高级的字体加载函数，FR_PRIVATE表示私有字体，不与其他应用共享
                FR_PRIVATE = 0x10
                logging.info("尝试使用AddFontResourceExW加载字体")
                result = gdi32.AddFontResourceExW(local_font_path, FR_PRIVATE, 0)
                if result > 0:
                    windll.user32.SendMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0)
                    logging.info("AddFontResourceExW成功，发送WM_FONTCHANGE消息")
                    return True, local_font_path
                else:
                    logging.warning(f"AddFontResourceExW失败，返回值: {result}")
            
            # 如果上面的方法失败，尝试普通加载方式
            if hasattr(gdi32, 'AddFontResourceW'):
                logging.info("尝试使用AddFontResourceW加载字体")
                result = gdi32.AddFontResourceW(local_font_path)
                if result > 0:
                    windll.user32.SendMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0)
                    logging.info("AddFontResourceW成功，发送WM_FONTCHANGE消息")
                    return True, local_font_path
                else:
                    logging.warning(f"AddFontResourceW失败，返回值: {result}")
        else:
            logging.warning("无法访问gdi32模块")
        
        logging.error("所有预加载字体方法均失败")
        return False, None
    except Exception:
        logging.exception("预加载字体时发生异常")
        return False, None

def install_font(font_path):
    """将字体安装到Windows字体文件夹并注册。"""
    logging.info(f"开始安装字体: {font_path}")
    try:
        # 首先检查字体文件是否存在
        if not os.path.exists(font_path):
            logging.error(f"字体文件不存在: {font_path}")
            return False, None
            
        # 字体安装相关常量
        FONTS_REG_PATH = r"Software\Microsoft\Windows NT\CurrentVersion\Fonts"
        HWND_BROADCAST = 0xFFFF
        WM_FONTCHANGE = 0x001D
        
        # 复制字体到本地应用目录，确保下次能找到
        app_font_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
        if not os.path.exists(app_font_dir):
            os.makedirs(app_font_dir)
            logging.info(f"创建字体目录: {app_font_dir}")
            
        local_font_path = os.path.join(app_font_dir, os.path.basename(font_path))
        
        # 确保目标路径与源不同时才复制
        if font_path != local_font_path:
            shutil.copy(font_path, local_font_path)
            logging.info(f"复制字体文件: {font_path} -> {local_font_path}")
        
        # 加载字体资源
        if hasattr(windll, 'gdi32'):
            gdi32 = windll.gdi32
            if hasattr(gdi32, 'AddFontResourceW'):
                result = gdi32.AddFontResourceW(local_font_path)
                logging.info(f"AddFontResourceW调用结果: {result}")
                
                # 通知Windows字体变更
                windll.user32.SendMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0)
                logging.info("发送WM_FONTCHANGE消息")
        else:
            logging.warning("无法访问gdi32模块")
        
        # 尝试添加到注册表（可能需要管理员权限）
        try:
            font_name = os.path.splitext(os.path.basename(font_path))[0]
            logging.info(f"尝试将字体添加到HKEY_LOCAL_MACHINE注册表: {font_name}")
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, FONTS_REG_PATH, 0, winreg.KEY_SET_VALUE) as key:
                winreg.SetValueEx(key, f"{font_name} (TrueType)", 0, winreg.REG_SZ, os.path.basename(font_path))
                logging.info("成功添加到HKEY_LOCAL_MACHINE注册表")
        except Exception as e:
            logging.warning(f"添加到HKEY_LOCAL_MACHINE注册表失败: {str(e)}")
            try:
                logging.info(f"尝试将字体添加到HKEY_CURRENT_USER注册表: {font_name}")
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, FONTS_REG_PATH, 0, winreg.KEY_SET_VALUE) as key:
                    winreg.SetValueEx(key, f"{font_name} (TrueType)", 0, winreg.REG_SZ, os.path.basename(font_path))
                    logging.info("成功添加到HKEY_CURRENT_USER注册表")
            except Exception as e:
                logging.warning(f"添加到HKEY_CURRENT_USER注册表失败: {str(e)}")
                # 注册表操作失败，但不影响后续使用
                pass
        
        logging.info(f"字体安装完成: {local_font_path}")
        return True, local_font_path
    except Exception:
        logging.exception("安装字体时发生异常")
        return False, None

class CountdownApp:
    def __init__(self, root, font_path=None):
        logging.info(f"初始化CountdownApp，字体路径: {font_path}")
        self.root = root
        self.font_path = font_path
        self.remaining_seconds = 5 * 60 * 60 + 30 * 60  # 5小时30分钟，转换为秒
        self.popup_windows = []
        
        # 设置主窗口
        self.root.overrideredirect(True)  # 移除窗口装饰
        self.root.attributes('-topmost', True)  # 保持窗口置顶
        self.root.configure(bg='#5e7dff')
        
        # 将窗口定位到桌面右下角
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        window_width = 150
        window_height = 66
        x_position = screen_width - window_width - 20
        y_position = screen_height - window_height - 50
        self.root.geometry(f"{window_width}x{window_height}+{x_position}+{y_position}")
        logging.info(f"窗口位置: {x_position},{y_position}, 大小: {window_width}x{window_height}")
        
        # 添加拖动功能所需的变量
        self.x = 0
        self.y = 0
        
        # 尝试设置字体
        self.custom_font = self.load_font(size=24)
        
        # 创建时间标签
        self.time_label = tk.Label(
            self.root, 
            text="",
            font=self.custom_font,
            fg="white",
            bg='#5e7dff'
        )
        self.time_label.pack(expand=True, fill='both')
        
        # 绑定鼠标事件，实现窗口拖动功能
        self.root.bind('<Button-1>', self.save_click_pos)
        self.root.bind('<B1-Motion>', self.dragging)
        self.time_label.bind('<Button-1>', self.save_click_pos)
        self.time_label.bind('<B1-Motion>', self.dragging)
        
        # 开始计时器
        self.update_timer()
    
    def load_font(self, size=12):
        """加载字体，如果失败则使用系统字体"""
        logging.info(f"开始加载字体，请求字号: {size}")
        
        # 获取系统可用字体
        available_fonts = list(font.families())
        logging.info(f"系统可用字体数量: {len(available_fonts)}")
        logging.debug(f"系统可用字体列表: {', '.join(available_fonts)}")
        
        # 首先尝试使用XNN字体（这是Nebulove.ttf的内部名称）
        try:
            logging.info("尝试使用'XNN'作为字体名称（首选方式）")
            font_obj = font.Font(family="XNN", size=size)
            test_width = font_obj.measure("测试")
            logging.info(f"文本'测试'的宽度: {test_width}")
            if test_width > 0:
                logging.info("成功使用'XNN'字体")
                return font_obj
        except Exception as e:
            logging.warning(f"使用'XNN'字体失败: {str(e)}")
        
        # 其次尝试使用字体文件名
        if self.font_path:
            font_name = os.path.splitext(os.path.basename(self.font_path))[0]
            logging.info(f"尝试使用字体文件名: {font_name}")
            
            if font_name in available_fonts:
                try:
                    font_obj = font.Font(family=font_name, size=size)
                    test_width = font_obj.measure("测试")
                    logging.info(f"文本'测试'的宽度: {test_width}")
                    if test_width > 0:
                        logging.info(f"成功使用'{font_name}'字体")
                        return font_obj
                except Exception as e:
                    logging.warning(f"使用'{font_name}'字体失败: {str(e)}")
        
        # 尝试其他可能的变体
        possible_names = ["XNN", "xnn"]
        if self.font_path:
            font_name = os.path.splitext(os.path.basename(self.font_path))[0]
            possible_names.extend([font_name.lower(), font_name.upper()])
        
        for name in possible_names:
            if name in available_fonts:
                try:
                    font_obj = font.Font(family=name, size=size)
                    test_width = font_obj.measure("测试")
                    logging.info(f"文本'测试'的宽度: {test_width}")
                    if test_width > 0:
                        logging.info(f"成功使用'{name}'字体")
                        return font_obj
                except Exception as e:
                    logging.warning(f"使用'{name}'字体失败: {str(e)}")
        
        # 如果自定义字体都失败，尝试常见中文字体
        chinese_fonts = ["微软雅黑", "宋体", "黑体", "仿宋", "楷体", "Arial"]
        logging.info(f"尝试系统中文字体: {chinese_fonts}")
        
        for font_name in chinese_fonts:
            if font_name in available_fonts:
                try:
                    font_obj = font.Font(family=font_name, size=size)
                    test_width = font_obj.measure("测试")
                    logging.info(f"文本'测试'的宽度: {test_width}")
                    if test_width > 0:
                        logging.info(f"成功使用系统字体: {font_name}")
                        return font_obj
                except Exception as e:
                    logging.warning(f"使用系统字体'{font_name}'失败: {str(e)}")
        
        # 最后使用默认字体
        logging.info("使用默认字体")
        return font.Font(size=size)
    
    def save_click_pos(self, event):
        """保存鼠标点击的位置"""
        self.x = event.x
        self.y = event.y
    
    def dragging(self, event):
        """处理窗口拖动"""
        x = self.root.winfo_x() + event.x - self.x
        y = self.root.winfo_y() + event.y - self.y
        self.root.geometry(f"+{x}+{y}")
    
    def update_timer(self):
        """更新计时器显示并检查是否需要提醒。"""
        if self.remaining_seconds <= 0:
            self.time_label.config(text="00:00:00")
            return
        
        hours, remainder = divmod(self.remaining_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        time_str = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        self.time_label.config(text=time_str)
        
        # 强制窗口置顶，防止被任务栏覆盖
        self.root.attributes('-topmost', True)
        
        # 检查是否进入30分钟警告区
        if self.remaining_seconds <= 30 * 60:
            # 将背景颜色更改为橙红色
            self.root.configure(bg='orangered')
            self.time_label.configure(bg='orangered')
            
            # 检查是否需要显示通知(每2分钟一次)
            if self.remaining_seconds <= 30*60 and self.remaining_seconds % 120 == 0:
                minutes_remaining = self.remaining_seconds // 60
                seconds_remaining = self.remaining_seconds % 60
                self.show_warning_popup(minutes_remaining, seconds_remaining)
        
        # 递减并安排下一次更新
        self.remaining_seconds -= 1
        self.root.after(1000, self.update_timer)
    
    def show_warning_popup(self, minutes, seconds):
        """当时间不多时显示警告弹窗。"""
        logging.info(f"显示警告弹窗，剩余时间: {minutes:02d}:{seconds:02d}")
        popup = tk.Toplevel(self.root)
        popup.overrideredirect(True)  # 移除标题栏
        popup.configure(bg='orangered')
        popup.attributes('-topmost', True)
        
        # 确定位置(如果已经有弹窗则偏移)
        offset = len(self.popup_windows) * 25
        popup_width = 300
        popup_height = 180
        popup.geometry(f"{popup_width}x{popup_height}+{100 + offset}+{100 + offset}")
        
        # 添加拖动功能所需的变量
        popup.x = 0
        popup.y = 0
        
        # 创建一个Frame作为容器以便更好地控制布局
        content_frame = tk.Frame(popup, bg='orangered')
        content_frame.pack(expand=True, fill='both', padx=15, pady=15)
        
        # 创建带自定义字体的消息
        message = tk.Label(
            content_frame,
            text=f"时间还剩 {minutes:02d}:{seconds:02d}",
            font=self.custom_font,
            bg='orangered',
            fg='white'
        )
        message.pack(pady=25, expand=True)
        
        # 创建一个Frame容器来控制按钮大小
        button_frame = tk.Frame(content_frame, bg='orangered')
        button_frame.pack(pady=15)
        
        # 创建样式较小的"我知道了"按钮
        button_font = font.Font(family=self.custom_font.actual()['family'], size=12)
        logging.info(f"弹窗按钮使用字体: family={self.custom_font.actual()['family']}, size=12")
        ok_button = tk.Button(
            button_frame,
            text="我知道了",
            font=button_font,
            command=lambda: self.close_popup(popup),
            width=13,
            height=1,
            relief=tk.GROOVE,
            bd=2
        )
        ok_button.pack()
        
        # 绑定鼠标事件，使弹窗也可拖动
        def save_popup_click_pos(event):
            popup.x = event.x
            popup.y = event.y
            
        def drag_popup(event):
            x = popup.winfo_x() + event.x - popup.x
            y = popup.winfo_y() + event.y - popup.y
            popup.geometry(f"+{x}+{y}")
        
        # 将拖动事件绑定到弹窗及其子组件
        popup.bind('<Button-1>', save_popup_click_pos)
        popup.bind('<B1-Motion>', drag_popup)
        content_frame.bind('<Button-1>', save_popup_click_pos)
        content_frame.bind('<B1-Motion>', drag_popup)
        message.bind('<Button-1>', save_popup_click_pos)
        message.bind('<B1-Motion>', drag_popup)
        
        # 添加到已打开的弹窗列表
        self.popup_windows.append(popup)
    
    def close_popup(self, popup):
        """关闭特定的弹窗。"""
        if popup in self.popup_windows:
            self.popup_windows.remove(popup)
        popup.destroy()

def main():
    try:
        # 设置日志系统
        log_file = setup_logging()
        
        # 首先检查这是否是子进程
        if len(sys.argv) > 1 and sys.argv[1] == "subprocess":
            logging.info("开始子进程执行流程")
            
            # 创建字体目录
            font_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
            if not os.path.exists(font_dir):
                os.makedirs(font_dir)
                logging.info(f"创建字体目录: {font_dir}")
            
            # 设置字体路径
            local_font_path = os.path.join(font_dir, "Nebulove.ttf")
            logging.info(f"本地字体路径: {local_font_path}")
            
            # 检查字体是否已存在
            if os.path.exists(local_font_path) and os.path.getsize(local_font_path) > 0:
                logging.info(f"本地字体文件已存在，大小: {os.path.getsize(local_font_path)} 字节")
                font_path = local_font_path
                download_success = True
            else:
                # 下载字体
                font_url = "https://raw.githubusercontent.com/lingyicute/Nebulove/main/Nebulove.ttf"
                temp_dir = tempfile.gettempdir()
                font_path = os.path.join(temp_dir, "Nebulove.ttf")
                logging.info(f"临时字体路径: {font_path}")
                
                logging.info("本地字体不存在或大小为0，开始下载字体")
                download_success = download_font(font_url, font_path)
                if download_success:
                    logging.info("下载成功，尝试复制到本地目录")
                    try:
                        shutil.copy(font_path, local_font_path)
                        font_path = local_font_path  # 使用本地副本
                        logging.info(f"字体已复制到本地: {local_font_path}")
                    except Exception as e:
                        logging.exception(f"复制字体到本地失败: {str(e)}")
            
            # 在创建Tk实例前加载字体
            if download_success:
                # 预加载字体到系统
                logging.info("开始预加载字体")
                preload_success, preloaded_path = preload_font(font_path)
                logging.info(f"预加载字体{'成功' if preload_success else '失败'}, 路径: {preloaded_path}")
                
                # 安装字体到系统
                install_success, installed_path = install_font(font_path)
                logging.info(f"系统安装字体{'成功' if install_success else '失败'}, 路径: {installed_path}")
                
                # 使用最终的字体路径
                final_font_path = preloaded_path if preload_success else (installed_path if install_success else font_path)
                logging.info(f"最终使用的字体路径: {final_font_path}")
                
                # 等待字体完全加载
                logging.info("等待字体完全加载...")
                time.sleep(1)
                
                # 启动计时器GUI
                logging.info("初始化Tkinter")
                root = tk.Tk()
                logging.info("创建CountdownApp实例")
                app = CountdownApp(root, final_font_path)
                logging.info("进入Tkinter主循环")
                root.mainloop()
            else:
                # 使用系统字体
                logging.warning("字体下载失败，使用系统字体")
                root = tk.Tk()
                app = CountdownApp(root)
                root.mainloop()
        else:
            # 主进程启动子进程并退出
            logging.info("这是主进程，即将启动子进程并退出")
            run_as_subprocess()
    except Exception:
        logging.exception("程序发生未捕获的异常")
        raise

if __name__ == "__main__":
    main()