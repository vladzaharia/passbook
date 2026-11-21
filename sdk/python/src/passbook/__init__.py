"""Python client for the PassBook API."""

from ._core import RequestOptions
from ._errors import (
    ApiError,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    NotFoundError,
    PassBookConnectionError,
    PassBookError,
    PermissionDeniedError,
    RateLimitError,
    ResponseError,
    ServerError,
    ValidationError,
    WebhookSignatureError,
)
from ._generated.models import *  # noqa: F403
from ._pagination import Page
from .client import PassBook
from .webhooks import verify_webhook

__all__ = [
    "ApiError",
    "AuthenticationError",
    "BadRequestError",
    "ConflictError",
    "NotFoundError",
    "Page",
    "PassBook",
    "PassBookConnectionError",
    "PassBookError",
    "PermissionDeniedError",
    "RateLimitError",
    "RequestOptions",
    "ResponseError",
    "ServerError",
    "ValidationError",
    "WebhookSignatureError",
    "verify_webhook",
]
