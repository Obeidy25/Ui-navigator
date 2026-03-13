import os
import logging

import pytesseract
from PIL import Image

logger = logging.getLogger("ui_navigator.ocr")

TESSERACT_PATH = r"C:\Program Files\Tesseract-OCR\tesseract.exe"


def extract_text(image_path: str) -> str:
    """Extract text from an image via Tesseract OCR.

    Raises FileNotFoundError if the image does not exist.
    Raises RuntimeError if Tesseract fails.
    """
    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"Image not found: {image_path}")

    pytesseract.pytesseract.tesseract_cmd = TESSERACT_PATH

    try:
        img = Image.open(image_path).convert("RGB")
        img.thumbnail((1400, 1400))  # reduce noise on very large images
        text = pytesseract.image_to_string(img, lang="eng")
        logger.info("OCR extracted %d chars from %s", len(text), image_path)
        return text.strip()
    except pytesseract.TesseractNotFoundError:
        raise RuntimeError(
            f"Tesseract not found at {TESSERACT_PATH}. "
            "Install Tesseract-OCR or update TESSERACT_PATH in ocr.py"
        )
    except Exception as exc:
        raise RuntimeError(f"OCR failed on {image_path}: {exc}") from exc
