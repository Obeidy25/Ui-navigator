import pytesseract
from PIL import Image

# إذا ما ضفت Tesseract للـ PATH سابقاً
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

image_path = "screen.jpg"

img = Image.open(image_path)
text = pytesseract.image_to_string(img)

print("===== Extracted Text =====")
print(text)
