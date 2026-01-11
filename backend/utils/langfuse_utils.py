"""
Langfuse utilities - Conditional Langfuse import for optional observability
"""
import os

# Check if Langfuse is configured
LANGFUSE_ENABLED = bool(os.getenv('LANGFUSE_PUBLIC_KEY')) and bool(os.getenv('LANGFUSE_SECRET_KEY'))

if LANGFUSE_ENABLED:
    from langfuse import Langfuse
    from langfuse.decorators import observe, langfuse_context
else:
    # Mock decorators when Langfuse is not available
    Langfuse = None
    
    def observe(*args, **kwargs):
        def decorator(func):
            return func
        return decorator
    
    class MockContext:
        @staticmethod
        def update_current_observation(*args, **kwargs):
            pass
        @staticmethod
        def get_current_trace():
            return None
    
    langfuse_context = MockContext()

# Export all
__all__ = ['LANGFUSE_ENABLED', 'Langfuse', 'observe', 'langfuse_context']
