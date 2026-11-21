from pydantic import BaseModel, ConfigDict


class Model(BaseModel):
    """Base of every generated model. Unknown fields are kept, so a newer API never breaks an older SDK."""

    model_config = ConfigDict(extra="allow", populate_by_name=True, protected_namespaces=())
